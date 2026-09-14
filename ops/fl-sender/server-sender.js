#!/usr/bin/env node
// FL.ru server-side auto-sender. Port of Mac autosend/auto.js to run inside the
// api image on the VDS: same draft gates, same form logic, same classifications.
// Differences: cookies/telegram token are decrypted straight from the DB (no
// ssh/docker-exec hops), publish time parsed as MSK (server runs UTC), and
// anti-block pacing (per-cycle cap + min gap between sends).
const { CryptoService } = require('/app/apps/api/dist/crypto.service.js');
const { Pool } = require('/app/node_modules/pg');
const puppeteer = require('/app/node_modules/puppeteer-core');

const CFG = {
  intervalSec: Number(process.env.SENDER_INTERVAL_SEC || 120),
  perCycle: Number(process.env.SENDER_MAX_PER_CYCLE || 1),
  minGapSec: Number(process.env.SENDER_MIN_GAP_SEC || 90),
  minDealPrice: Number(process.env.AUTOSEND_MIN_DEAL_PRICE || 30000),
  maxAgeSec: Number(process.env.AUTOSEND_MAX_AGE || 900),
  windowMin: Number(process.env.SENDER_WINDOW_MIN || 40),
  limit: Number(process.env.SENDER_CANDIDATES_LIMIT || 5),
  dry: process.env.AUTOSEND_DRY === '1',
  rehearse: process.env.AUTOSEND_REHEARSE === '1',
  once: process.env.SENDER_ONCE === '1',
  chrome: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
  tgChat: Number(process.env.SENDER_TG_CHAT || 677822370),
  lockId: 901251,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
};

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const cryptoService = new CryptoService();

async function tg(text) {
  try {
    const { rows } = await pool.query("SELECT encrypted_value AS v FROM settings WHERE key='telegram_bot_token'");
    if (!rows[0]) return;
    const token = cryptoService.decrypt(rows[0].v);
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ chat_id: String(CFG.tgChat), text }),
    });
  } catch (e) { log('TG send fail: ' + e.message); }
}

async function loadCookies() {
  const { rows } = await pool.query("SELECT encrypted_value FROM settings WHERE key='fl_cookies'");
  if (!rows[0]) throw new Error('fl_cookies не настроены');
  const cookies = JSON.parse(cryptoService.decrypt(rows[0].encrypted_value));
  const clean = cookies
    .filter((c) => c && c.name && typeof c.value === 'string' && !/[;\s]/.test(c.value))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.fl.ru',
      path: c.path || '/',
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      ...(Number.isFinite(Number(c.expirationDate)) && Number(c.expirationDate) > 0 ? { expires: Math.floor(Number(c.expirationDate)) } : {}),
    }));
  if (!clean.some((c) => c.name === 'pwd')) throw new Error('куки без pwd — сессия невалидна');
  return clean;
}

async function candidates(limit) {
  const { rows } = await pool.query(
    `SELECT d.id, l.url, COALESCE(l.recommended_price,0) AS price, COALESCE(l.recommended_days,0) AS days,
            COALESCE(l.analysis->>'size_grade','medium') AS grade,
            COALESCE(d.metadata->>'price','')::text AS meta_price,
            COALESCE(l.requirements#>>'{project,budget_amount}','') AS budget_amount,
            d.content
       FROM drafts d JOIN leads l ON l.id=d.lead_id
      WHERE d.kind='initial_response' AND d.channel='fl' AND d.status='pending'
        AND (COALESCE(l.analysis->>'size_grade','medium') IN ('medium','large') OR COALESCE(l.recommended_price,0) >= $1)
        AND d.created_at > now() - ($2 || ' minutes')::interval
        AND NOT COALESCE((d.metadata#>'{review,flags}') ? 'style_check_failed', false)
        AND NOT COALESCE((d.metadata->>'hold_for_owner')::boolean, false)
        AND NOT EXISTS (SELECT 1 FROM drafts x WHERE x.lead_id=d.lead_id AND x.kind='initial_response' AND x.channel='fl' AND x.status='sent')
      ORDER BY COALESCE(l.recommended_price,0) DESC LIMIT $3`,
    [CFG.minDealPrice, String(CFG.windowMin), limit],
  );
  return rows.map((r) => ({
    id: r.id, url: r.url, price: Number(r.price) || 0, days: Number(r.days) || 0,
    grade: r.grade, metaPrice: Number(r.meta_price) || 0, budgetAmount: Number(r.budget_amount) || 0,
    content: r.content,
  })).filter((c) => {
    const formPrice = Math.min(c.metaPrice || c.price || 0, 999999);
    if (c.budgetAmount && c.metaPrice && formPrice !== Math.min(c.budgetAmount, 999999)) {
      log(`skip ${c.id}: formPrice ${formPrice} != fixed budget ${c.budgetAmount} (cap 999999)`);
      return false;
    }
    return true;
  });
}

async function markSent(id) {
  await pool.query("UPDATE drafts SET status='sent', sent_at=now(), updated_at=now() WHERE id=$1", [id]);
  await pool.query("INSERT INTO activities(lead_id,actor,action,details) SELECT lead_id,'ai','auto_sent_fl','{}'::jsonb FROM drafts WHERE id=$1", [id]);
}
async function markTooOld(id) {
  await pool.query("UPDATE drafts SET status='rejected', metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('auto_too_old',true), updated_at=now() WHERE id=$1", [id]);
}
async function markAlreadyResponded(id) {
  await pool.query("UPDATE drafts SET status='rejected', metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('auto_already_responded',true), updated_at=now() WHERE id=$1", [id]);
}

// FL renders publish time in <title> as MSK wall clock; the server runs UTC, so
// interpret the parsed components as UTC+3 explicitly instead of host-local.
function parsePublishSec(title) {
  const m = (title || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\D+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, d, mo, y, h, mi] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi) / 1000 - 3 * 3600;
}

async function sendOffer(browser, cookies, c, rehearse = false) {
  const page = await browser.newPage();
  try {
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await page.setUserAgent(CFG.userAgent);
    await page.setViewport({ width: 1512, height: 900 });
    await page.setCookie(...cookies);
    // FL keeps long-polling connections alive; networkidle2 intermittently times
    // out. Load the DOM, settle briefly, then rely on explicit waitForSelector.
    await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
      if (!/timeout/i.test(e.message) || !/fl\.ru/.test(page.url())) throw e;
    });
    await new Promise((r) => setTimeout(r, 5000));
    try {
      await page.waitForSelector('#newoffer', { timeout: 30000 });
    } catch (e) {
      // No fresh-offer form: already responded, vacancy, or closed — classify once.
      const state = await page.evaluate((snippet) => ({
        myOffer: !!document.querySelector('#my-offer'),
        sameText: (document.body.innerText || '').replace(/\s+/g, ' ').includes(snippet),
        vacancy: /Ссылка на вакансию/.test(document.body.innerText || ''),
        captcha: !!document.querySelector('iframe[src*="captcha"], [class*="captcha"], input[name*="captcha"]'),
      }), c.content.replace(/\s+/g, ' ').trim().slice(0, 40)).catch(() => ({ myOffer: false, sameText: false, vacancy: false, captcha: false }));
      if (state.captcha) throw new Error('CAPTCHA: FL запросил капчу — сессия под угрозой, остановлено');
      if (state.myOffer && state.sameText) return { ok: true, alreadyOnFl: true };
      if (state.myOffer) return { ok: false, alreadyResponded: true, reason: 'отклик на FL уже отправлен (другой текст)' };
      if (state.vacancy) return { ok: false, alreadyResponded: true, reason: 'это вакансия — формы отклика нет' };
      throw e;
    }
    const captchaOnForm = await page.$('iframe[src*="captcha"], [class*="captcha"], input[name*="captcha"]').catch(() => null);
    if (captchaOnForm) throw new Error('CAPTCHA on offer form — остановлено');

    const pubSec = parsePublishSec(await page.title());
    if (pubSec) {
      const age = Math.round(Date.now() / 1000) - pubSec;
      if (rehearse) log(`rehearse: title parsed (MSK), project age ${Math.round(age / 60)} min`);
      else if (age > CFG.maxAgeSec) return { ok: false, tooOld: true, reason: `project age ${Math.round(age / 60)} min > ${Math.round(CFG.maxAgeSec / 60)} min` };
      else log(`grade=${c.grade} ${c.price}₽: project age ${Math.round(age / 60)} min — sending`);
    }

    const hash = await page.evaluate(() => (document.querySelector('input[name="hash"]') || {}).value || null);
    if (!hash) return { ok: false, fatal: true, reason: 'no form/hash (logged out?)' };
    if (rehearse) log(`rehearse: session ok (hash found), budget=${c.budgetAmount || '—'} metaPrice=${c.metaPrice || '—'}`);
    await page.evaluate((t, price, days) => {
      document.querySelector('#el-descr').value = t;
      if (price) document.querySelector('#el-cost_from').value = String(price);
      if (days) document.querySelector('#el-time_from').value = String(days);
    }, c.content, Math.min(c.metaPrice || c.price || 0, 999999), c.days);
    if (rehearse) {
      const filled = await page.evaluate(() => ({
        text: (document.querySelector('#el-descr').value || '').length,
        price: document.querySelector('#el-cost_from').value || '',
        days: document.querySelector('#el-time_from').value || '',
      }));
      log(`rehearse: form filled (text ${filled.text} chars, price ${filled.price}, days ${filled.days}) — NO submit`);
      return { ok: true, rehearsed: true };
    }
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
      page.click('#el-submit'),
    ]);
    await new Promise((r) => setTimeout(r, 5000));
    const res = await page.evaluate((snippet) => ({
      myOffer: !!document.querySelector('#my-offer'),
      offerOnPage: document.body.innerText.includes(snippet),
    }), c.content.replace(/\s+/g, ' ').trim().slice(0, 40));
    if (!res.myOffer && !res.offerOnPage) return { ok: false, reason: 'no confirmation after submit' };
    return { ok: true };
  } finally { await page.close().catch(() => {}); }
}

async function minGapOk() {
  const { rows } = await pool.query(
    `SELECT extract(epoch FROM now()-max(sent_at))::int AS gap FROM drafts
      WHERE channel='fl' AND kind='initial_response' AND sent_at IS NOT NULL`,
  );
  const gap = rows[0]?.gap;
  if (gap !== null && gap !== undefined && gap < CFG.minGapSec) {
    log(`min gap: last FL offer ${gap}s ago (< ${CFG.minGapSec}s) — пауза, отправка в следующем цикле`);
    return false;
  }
  return true;
}

async function cycle() {
  const client = await pool.connect();
  try {
    const lock = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [CFG.lockId])).rows[0].ok;
    if (!lock) { log('another sender holds the lock, skip'); return; }
    try {
      const list = await candidates(CFG.limit);
      if (!list.length) { log('no fresh candidates, done'); return; }
      log(`candidates: ${list.map((c) => `grade=${c.grade} ${c.price}₽ ${c.url}`).join(' ; ')}`);
      if (CFG.dry) { log('DRY RUN — nothing sent'); return; }

      const cookies = await loadCookies();
      const browser = await puppeteer.launch({
        executablePath: CFG.chrome, headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--lang=ru-RU', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      try {
        if (CFG.rehearse) {
          const r = await sendOffer(browser, cookies, list[0], true);
          log(`rehearse ${r.ok ? 'PASSED' : 'FAILED'}: ${r.ok ? 'form ready, nothing sent' : (r.reason || 'unknown')}`);
          return;
        }
        if (!(await minGapOk())) return;
        let sent = 0;
        for (const c of list) {
          if (sent >= CFG.perCycle) break;
          try {
            const r = await sendOffer(browser, cookies, c);
            if (r.ok) {
              await markSent(c.id);
              sent++;
              if (r.alreadyOnFl) log(`ALREADY ON FL grade=${c.grade} ${c.price}₽ ${c.url} — помечен sent`);
              else {
                log(`SENT grade=${c.grade} ${c.price}₽ ${c.url}`);
                await tg(`✅ Автоотклик отправлен с сервера (${c.grade}, ${c.price} ₽)\n${c.url}`);
              }
            } else if (r.alreadyResponded) {
              await markAlreadyResponded(c.id);
              log(`ALREADY RESPONDED grade=${c.grade} ${c.price}₽ ${c.url}: ${r.reason} — draft отклонён`);
            } else if (r.fatal) {
              log(`FATAL ${r.reason}`);
              await tg(`⚠️ Автоотклик остановился: ${r.reason}. Нужны свежие куки FL.ru.`);
              break;
            } else if (r.tooOld) {
              await markTooOld(c.id);
              log(`TOO OLD grade=${c.grade} ${c.price}₽: ${r.reason} — draft отклонён`);
            } else {
              log(`SKIP grade=${c.grade} ${c.price}₽: ${r.reason}`);
            }
          } catch (e) {
            if (/CAPTCHA/i.test(e.message)) {
              log('FATAL ' + e.message);
              await tg('⚠️ Автоотклик остановлен: ' + e.message);
              return;
            }
            log(`ERR grade=${c.grade} ${c.price}₽: ${e.message}`);
          }
        }
        log(`done, sent=${sent}`);
      } finally { await browser.close().catch(() => {}); }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [CFG.lockId]);
    }
  } finally { client.release(); }
}

(async () => {
  log(`fl-sender started (interval ${CFG.intervalSec}s, perCycle ${CFG.perCycle}, dry=${CFG.dry ? 1 : 0}, rehearse=${CFG.rehearse ? 1 : 0})`);
  do {
    try { await cycle(); } catch (e) { log('FATAL ' + e.message); }
    if (CFG.once) break;
    await new Promise((r) => setTimeout(r, CFG.intervalSec * 1000));
  } while (true);
  await pool.end().catch(() => {});
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
