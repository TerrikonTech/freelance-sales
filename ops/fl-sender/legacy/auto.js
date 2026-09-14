#!/usr/bin/env node
// FL.ru auto-sender: pending drafts (grade medium/large, либо цена >= MIN_DEAL 30k) -> real Chrome on this Mac -> mark sent -> Telegram notify.
const { execFileSync } = require('child_process');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CFG = {
  minDealPrice: Number(process.env.AUTOSEND_MIN_DEAL_PRICE || 30000),
  minAgeSec: Number(process.env.AUTOSEND_MIN_AGE || 0),     // отправляем сразу, без ожидания
  maxAgeSec: Number(process.env.AUTOSEND_MAX_AGE || 900),   // не позже 15 мин после публикации
  dry: process.env.AUTOSEND_DRY === '1',
  rehearse: process.env.AUTOSEND_REHEARSE === '1', // репетиция: страница, куки, форма — БЕЗ сабмита
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  lock: '/tmp/fl-autosend.lock',
  log: process.env.AUTOSEND_LOG || '/tmp/fl-autosend.log',
};

const SSH = ['ssh', '-o', 'ConnectTimeout=25', 'codex-mesh'];
const PSQL = 'docker exec freelance-sales-v2-postgres-1 psql -U freelance -d freelance -tA -c';
const API = 'docker exec freelance-sales-v2-api-1 sh -c';

function sh(args, input) {
  return execFileSync(args[0], args.slice(1), { input, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
}
function sshRun(remoteCmd) {
  // The server's sshd drops some connections during banner exchange; one
  // attempt must not cost a whole cycle, so retry a few times before failing.
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return sh(['ssh', '-o', 'ConnectTimeout=25', 'codex-mesh', remoteCmd]);
    } catch (error) {
      lastError = error;
      const message = String(error && error.message || error);
      // Only connection-level flakes are worth retrying; auth or command
      // errors will repeat identically.
      if (!/banner|timed out|Connection (reset|closed)|refused/i.test(message)) throw error;
      if (attempt < 2) sh(['sleep', '10']);
    }
  }
  throw lastError;
}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(CFG.log, line + '\n');
  console.log(line);
}
function sql(q) {
  return sshRun(`docker exec freelance-sales-v2-postgres-1 psql -U freelance -d freelance -tA -c "${q}"`).trim();
}

function getCookies() {
  const out = sshRun(`docker exec freelance-sales-v2-api-1 sh -c 'node /tmp/dumpcookieheader.js >/dev/null 2>&1; cat /tmp/fl_cookie_header.txt'`).trim();
  if (!out.includes('pwd=')) throw new Error('no cookies / decrypt failed');
  return out;
}

const TG_TOKEN_JS = Buffer.from(
  `const {CryptoService}=require('/app/apps/api/dist/crypto.service.js');` +
  `const {Pool}=require('/app/node_modules/pg');` +
  `(async()=>{const p=new Pool({connectionString:process.env.DATABASE_URL});` +
  `const r=await p.query("SELECT encrypted_value AS v FROM settings WHERE key='telegram_bot_token'");` +
  `console.log(new CryptoService().decrypt(r.rows[0].v));await p.end();})().catch(e=>{console.error(e.message);process.exit(1)})`
).toString('base64');

function getTelegram() {
  try {
    const token = sshRun(`docker exec freelance-sales-v2-api-1 sh -c 'echo ${TG_TOKEN_JS} | base64 -d > /tmp/tgtoken.js && node /tmp/tgtoken.js'`).trim();
    if (!token || /\s/.test(token)) throw new Error('bad token');
    return { token, chat: 677822370 };
  } catch (e) { log('TG token fail: ' + e.message); return null; }
}
function tg(tgCfg, text) {
  if (!tgCfg) return;
  try {
    sh(['curl', '-s', '-m', '15', '-o', '/dev/null',
      `https://api.telegram.org/bot${tgCfg.token}/sendMessage`,
      '--data-urlencode', `chat_id=${tgCfg.chat}`, '--data-urlencode', `text=${text}`]);
  } catch (e) { log('TG send fail: ' + e.message); }
}

function candidates(limit) {
  const q = `SELECT d.id||'|'||l.url||'|'||COALESCE(l.recommended_price::text,'')||'|'||COALESCE(l.recommended_days::text,'')||'|'||COALESCE(l.analysis->>'size_grade','')||'|'||l.score||'|'||COALESCE(d.metadata->>'price','')||'|'||COALESCE(l.requirements#>>'{project,budget_amount}','')||'|'||COALESCE(d.metadata#>>'{review,flags}','')||'|'||replace(encode(convert_to(d.content,'UTF8'),'base64'), chr(10), '') FROM drafts d JOIN leads l ON l.id=d.lead_id WHERE d.kind='initial_response' AND d.channel='fl' AND d.status='pending' AND (COALESCE(l.analysis->>'size_grade','medium') IN ('medium','large') OR COALESCE(l.recommended_price,0) >= ${CFG.minDealPrice}) AND d.created_at > now() - interval '40 minutes' AND NOT COALESCE((d.metadata#>'{review,flags}') ? 'style_check_failed', false) AND NOT COALESCE((d.metadata->>'hold_for_owner')::boolean, false) AND NOT EXISTS (SELECT 1 FROM drafts x WHERE x.lead_id=d.lead_id AND x.kind='initial_response' AND x.channel='fl' AND x.status='sent') ORDER BY COALESCE(l.recommended_price,0) DESC LIMIT ${limit}`;
  return sql(q).split('\n').filter(Boolean).map(line => {
    const [id, url, price, days, grade, score, metaPrice, budgetAmount, flags, b64] = line.split('|');
    return { id, url, price: Number(price) || 0, days: Number(days) || 0, grade: grade || 'medium', score: Number(score), metaPrice: Number(metaPrice) || 0, budgetAmount: Number(budgetAmount) || 0, flags: flags || '', content: Buffer.from(b64 || '', 'base64').toString('utf8') };
  }).filter(c => {
    // Гейт цены: у заказа с фиксированным бюджетом в черновике должна стоять именно она.
    // Поле цены на FL.ru ограничено 999 999 — бюджеты выше сравниваем по потолку платформы.
    const formPrice = Math.min(c.metaPrice || c.price || 0, 999999);
    if (c.budgetAmount && c.metaPrice && formPrice !== Math.min(c.budgetAmount, 999999)) { log(`skip ${c.id}: formPrice ${formPrice} != fixed budget ${c.budgetAmount} (cap 999999)`); return false; }
    return true;
  });
}
function markSent(id) {
  sql(`UPDATE drafts SET status='sent', sent_at=now(), updated_at=now() WHERE id='${id}'`);
  sql(`INSERT INTO activities(lead_id,actor,action,details) SELECT lead_id,'ai','auto_sent_fl','{}'::jsonb FROM drafts WHERE id='${id}'`);
}
function markTooOld(id) {
  sql(`UPDATE drafts SET status='rejected', metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('auto_too_old',true), updated_at=now() WHERE id='${id}'`);
}

function parsePublishSec(title) {
  const m = (title || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\D+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]).getTime() / 1000;
}

async function sendOffer(browser, cookieStr, c, rehearse = false) {
  const page = await browser.newPage();
  try {
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    const cookies = cookieStr.split(/;\s*/).filter(Boolean).map(p => {
      const i = p.indexOf('=');
      return { name: p.slice(0, i), value: p.slice(i + 1), domain: '.fl.ru', path: '/' };
    });
    await page.setCookie(...cookies);
    await page.goto(c.url, { waitUntil: 'networkidle2', timeout: 60000 });
    try {
      await page.waitForSelector('#newoffer', { timeout: 30000 });
    } catch (e) {
      // No fresh-offer form: either we already responded to this project (FL shows
      // «Ваш отклик») or it closed. Previously this threw and retried every cycle
      // for 40 minutes; classify once and retire the draft.
      const state = await page.evaluate((snippet) => ({
        myOffer: !!document.querySelector('#my-offer'),
        sameText: (document.body.innerText || '').replace(/\s+/g, ' ').includes(snippet),
        vacancy: /Ссылка на вакансию/.test(document.body.innerText || ''),
      }), c.content.replace(/\s+/g, ' ').trim().slice(0, 40)).catch(() => ({ myOffer: false, sameText: false, vacancy: false }));
      if (state.myOffer && state.sameText) return { ok: true, alreadyOnFl: true };
      if (state.myOffer) return { ok: false, alreadyResponded: true, reason: 'отклик на FL уже отправлен (другой текст)' };
      if (state.vacancy) return { ok: false, alreadyResponded: true, reason: 'это вакансия — формы отклика нет' };
      throw e;
    }

    // возраст проекта: время публикации из <title> (MSK = локальное время Мака)
    const pubSec = parsePublishSec(await page.title());
    if (pubSec) {
      let age = Math.round(Date.now() / 1000) - pubSec;
      if (rehearse) log(`rehearse: title parsed, project age ${Math.round(age / 60)} min`);
      else {
      if (age > CFG.maxAgeSec) return { ok: false, tooOld: true, reason: `project age ${Math.round(age / 60)} min > 15 min` };
      log(`grade=${c.grade} ${c.price}₽: project age ${Math.round(age / 60)} min — sending`);
      }
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
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}),
      page.click('#el-submit'),
    ]);
    await new Promise(r => setTimeout(r, 5000));
    const res = await page.evaluate((snippet) => ({
      myOffer: !!document.querySelector('#my-offer'),
      offerOnPage: document.body.innerText.includes(snippet),
    }), c.content.replace(/\s+/g, ' ').trim().slice(0, 40));
    if (!res.myOffer && !res.offerOnPage) return { ok: false, reason: 'no confirmation after submit' };
    return { ok: true };
  } finally { await page.close().catch(() => {}); }
}

(async () => { 
  if (fs.existsSync(CFG.lock)) { log('another run in progress, skip'); return; }
  try { fs.mkdirSync(CFG.lock); } catch { log('stale lock, removing and skipping this cycle'); fs.rmSync(CFG.lock, { force: true, recursive: true }); return; }
  try {
    const list = candidates(5);
    if (!list.length) { log('no fresh candidates, done'); return; }
    log(`candidates: ${list.map(c => `grade=${c.grade} ${c.price}₽ ${c.url}`).join(' ; ')}`);
    if (CFG.dry) { log('DRY RUN — nothing sent'); return; }

    const cookieStr = getCookies();
    const tgCfg = getTelegram();
    const browser = await puppeteer.launch({
      executablePath: CFG.chrome, headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--lang=ru-RU'],
    });
    if (CFG.rehearse) {
      const c = list[0];
      try {
        const r = await sendOffer(browser, cookieStr, c, true);
        log(`rehearse ${r.ok ? 'PASSED' : 'FAILED'}: ${r.ok ? 'form ready, nothing sent' : (r.reason || 'unknown')}`);
      } catch (e) { log('rehearse FAILED: ' + e.message); }
      await browser.close();
      return;
    }
    let sent = 0;
    for (const c of list) {
      try {
        const r = await sendOffer(browser, cookieStr, c);
        if (r.ok) {
          if (r.alreadyOnFl) {
            // The exact draft text is already published on FL (a previous run sent
            // it but died before markSent) — reconcile the ledger, no new submit.
            markSent(c.id);
            log(`ALREADY ON FL grade=${c.grade} ${c.price}₽ ${c.url} — помечен sent`);
          } else {
            markSent(c.id);
            sent++;
            log(`SENT grade=${c.grade} ${c.price}₽ ${c.url}`);
            tg(tgCfg, `✅ Автоотклик отправлен (${c.grade}, ${c.price} ₽)\n${c.url}`);
          }
        } else if (r.alreadyResponded) {
          sql(`UPDATE drafts SET status='rejected', metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('auto_already_responded',true), updated_at=now() WHERE id='${c.id}'`);
          log(`ALREADY RESPONDED grade=${c.grade} ${c.price}₽ ${c.url}: ${r.reason} — draft отклонён`);
        } else if (r.fatal) {
          log(`FATAL ${r.reason}`);
          tg(tgCfg, `⚠️ Автоотклик остановился: ${r.reason}. Нужны свежие куки FL.ru.`);
          break;
        } else {
          if (r.tooOld) { markTooOld(c.id); log(`TOO OLD grade=${c.grade} ${c.price}₽: ${r.reason} — draft отклонён`); }
          else log(`SKIP grade=${c.grade} ${c.price}₽: ${r.reason}`);
        }
      } catch (e) { log(`ERR grade=${c.grade} ${c.price}₽: ${e.message}`); }
    }
    await browser.close();
    log(`done, sent=${sent}`);
  } catch (e) {
    log('FATAL ' + e.message);
  } finally {
    fs.rmSync(CFG.lock, { force: true, recursive: true });
  }
})();
