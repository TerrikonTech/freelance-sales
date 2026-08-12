import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import puppeteer, { Browser, CookieData } from 'puppeteer-core';
import { DatabaseService } from './database.service';
import { JobProgressService } from './job-progress.service';
import { OutboundDeliveryUnknownError, OutboundPreflightError } from './outbound-errors';
import { ProjectAttachmentsService } from './project-attachments.service';
import { QueueService } from './queue.service';
import { PushService } from './push.service';
import { SettingsService } from './settings.service';

export type FlProfileIdentity = {
  name: string | null;
  username: string | null;
};

export function flProfileIdentity(
  href: string | null | undefined,
  label: string | null | undefined,
): FlProfileIdentity {
  let username: string | null = null;
  try {
    const url = new URL(String(href || ''), 'https://www.fl.ru');
    if (url.hostname === 'fl.ru' || url.hostname === 'www.fl.ru') {
      const match = url.pathname.match(/^\/users\/([^/?#]+)/iu);
      username = match?.[1] ? decodeURIComponent(match[1]).trim().slice(0, 100) : null;
    }
  } catch {
    username = null;
  }
  const cleaned = String(label || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const plausibleName = /^[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2}$/u.test(cleaned);
  const name = username
    && cleaned
    && plausibleName
    && !/^(?:profile|профиль|пользователь|заказчик|клиент)$/iu.test(cleaned)
      ? cleaned
      : null;
  return { name, username };
}

const normalizeFlOfferText = (value: string) => String(value || '').replace(/\s+/g, ' ').trim();

export function flCookieHeader(cookies: Array<Pick<CookieData, 'name' | 'value'>>) {
  return cookies
    .filter((cookie) => cookie?.name && cookie?.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export function matchesExistingFlOffer(existingOffer: string, draftContent: string) {
  const existing = normalizeFlOfferText(existingOffer);
  const draft = normalizeFlOfferText(draftContent);
  if (!draft) return false;
  if (existing.includes(draft)) return true;
  if (draft.length < 160) return false;
  const boundaryLength = Math.min(100, Math.max(60, Math.floor(draft.length / 8)));
  if (!existing.includes(draft.slice(0, boundaryLength))
    || !existing.includes(draft.slice(-boundaryLength))) return false;
  const tokens = (value: string) => value.toLocaleLowerCase('ru')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3);
  const draftTokens = tokens(draft);
  const available = new Map<string, number>();
  for (const token of tokens(existing)) available.set(token, (available.get(token) || 0) + 1);
  let matched = 0;
  for (const token of draftTokens) {
    const count = available.get(token) || 0;
    if (count > 0) {
      matched += 1;
      available.set(token, count - 1);
    }
  }
  return draftTokens.length > 0 && matched / draftTokens.length >= 0.85;
}

@Injectable()
export class FlService {
  private readonly logger = new Logger(FlService.name);
  constructor(
    private readonly db: DatabaseService,
    private readonly attachments: ProjectAttachmentsService,
    private readonly queue: QueueService,
    private readonly push: PushService,
    private readonly settings: SettingsService,
    private readonly progress: JobProgressService,
  ) {}

  async scan(options: { force?: boolean } = {}) {
    const state = await this.flState();
    if (!state.enabled && !options.force) return { found: 0, created: 0, analyzed: 0, skippedKnown: 0, disabled: true };
    const startedAt = Date.now();
    try {
      await this.progress.advance('fetch', 'Открываю ленту заказов');
      const cookiesRaw = await this.settings.getSecret('fl_cookies').catch(() => null);
      const cookies = cookiesRaw ? JSON.parse(cookiesRaw) as CookieData[] : [];
      const cookie = flCookieHeader(cookies);
      const response = await fetch('https://www.fl.ru/projects/', {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; FreelanceSales/2.0)',
          ...(cookie ? { cookie } : {}),
        },
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) throw new Error(`FL scan HTTP ${response.status}`);
      const html = await response.text();
      const $ = cheerio.load(html);
      const items: Array<{ externalId: string; title: string; url: string; budget: string; description: string }> = [];
      $('.b-post').each((_, element) => {
        const root = $(element);
        const anchor = root.find('.b-post__title a').first();
        const href = anchor.attr('href') || '';
        const match = href.match(/\/projects\/(\d+)\//);
        const externalId = root.attr('id') || (match?.[1] ? `project-item${match[1]}` : '');
        const title = anchor.text().trim();
        if (!externalId || !title) return;
        items.push({
          externalId,
          title,
          url: href.startsWith('http') ? href : `https://www.fl.ru${href}`,
          budget: root.find('.b-post__price').text().replace(/\s+/g, ' ').trim(),
          description: root.find('.b-post__txt').text().replace(/\s+/g, ' ').trim(),
        });
      });

      await this.progress.advance('dedupe', 'Отбрасываю уже известные заказы', `в ленте ${items.length}`);
      const externalIds = items.map((item) => item.externalId);
      const known = externalIds.length
        ? await this.db.query<{ external_id: string }>(
          `SELECT external_id FROM leads WHERE source='fl' AND external_id=ANY($1::text[])`,
          [externalIds],
        )
        : { rows: [] as Array<{ external_id: string }> };
      const knownIds = new Set(known.rows.map((row) => row.external_id));
      const rememberedIds = new Set(
        Array.isArray(state.cursor?.seen_project_ids)
          ? state.cursor.seen_project_ids.filter((value): value is string => typeof value === 'string')
          : [],
      );
      const freshItems = items.filter((item) => !knownIds.has(item.externalId) && !rememberedIds.has(item.externalId));
      await this.progress.advance(
        'read',
        'Сразу добавляю новые заказы на Dashboard',
        freshItems.length ? `новых ${freshItems.length}` : 'новых заказов нет',
      );
      let created = 0;
      for (const item of freshItems) {
        const requirements = {
          project: {
            listing_detected_at: new Date().toISOString(),
            detail_parsed_at: null,
            attachments: [],
          },
        };
        const result = await this.db.query<{ id: string }>(
          `INSERT INTO leads(source,external_id,title,description,url,budget_text,requirements,client)
           VALUES('fl',$1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(source,external_id) DO NOTHING RETURNING id`,
          [
            item.externalId,
            item.title,
            item.description,
            item.url,
            item.budget,
            JSON.stringify(requirements),
            JSON.stringify({}),
          ],
        );
        if (result.rows[0]) created += 1;
      }

      // Database insertion and queue publication are not atomic. Reconcile all
      // recent idle leads on every scan so a short Redis outage cannot leave an
      // order invisible and unanalyzed forever.
      const pending = await this.db.query<{ id: string }>(
        `SELECT id FROM leads
         WHERE source='fl' AND analysis_state='idle'
           AND external_id NOT LIKE 'dialog:%'
           AND created_at >= now()-interval '24 hours'
         ORDER BY created_at LIMIT 50`,
      );
      const analysisBucket = Math.floor(Date.now() / 60_000);
      for (const lead of pending.rows) {
        await this.queue.add(
          'analyze-lead',
          { leadId: lead.id },
          'analyze-' + lead.id + '-' + analysisBucket,
        );
      }
      await this.progress.advance(
        'save',
        'Ставлю новые заказы на оценку',
        'добавлено ' + created + ' · в очереди ' + pending.rows.length,
      );
      const durationMs = Date.now() - startedAt;
      const skippedKnown = items.length - created;
      await Promise.all([
        this.db.query(
          `INSERT INTO scan_runs(connector,found_count,new_count,analyzed_count,skipped_known_count,duration_ms)
           VALUES('fl',$1,$2,0,$3,$4)`,
          [items.length, created, skippedKnown, durationMs],
        ),
        this.db.query(
          `UPDATE connector_state SET
           healthy=NOT (cursor ? 'cookie_auth_alert'),
           status_text=CASE WHEN cursor ? 'cookie_auth_alert'
             THEN 'Проекты проверены, но cookies FL.ru недействительны'
             ELSE $1 END,
           last_success_at=CASE WHEN cursor ? 'cookie_auth_alert' THEN last_success_at ELSE now() END,
           cursor=cursor || $2::jsonb,updated_at=now() WHERE connector='fl'`,
          [`Проверено ${items.length}, новых ${created} · ${durationMs} мс`, JSON.stringify({
            last_project_id: items[0]?.externalId || null,
            last_found: items.length,
            last_new: created,
            last_skipped_known: skippedKnown,
            last_duration_ms: durationMs,
            last_scan_at: new Date().toISOString(),
            seen_project_ids: [...new Set([
              ...items.map((item) => item.externalId),
              ...rememberedIds,
            ])].slice(0, 500),
          })],
        ),
      ]);
      return { found: items.length, created, analyzed: 0, queued: pending.rows.length, skippedKnown, durationMs };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка FL';
      await this.settings.setConnectorState('fl', { healthy: false, statusText: message.slice(0, 180) });
      throw error;
    }
  }

  async syncPortfolioIfDue() {
    const state = await this.flState();
    if (!state.enabled) return { skipped: true, reason: 'disabled' };
    const lastSync = state.cursor?.portfolio_last_sync_at
      ? Date.parse(state.cursor.portfolio_last_sync_at)
      : 0;
    if (lastSync && Date.now() - lastSync < 6 * 60 * 60 * 1_000) {
      return { skipped: true, reason: 'not_due' };
    }
    const cookiesRaw = await this.settings.getSecret('fl_cookies');
    if (!cookiesRaw) return { skipped: true, reason: 'cookies_missing' };
    const cookies = JSON.parse(cookiesRaw) as CookieData[];
    await this.checkCookieExpiry(cookies);
    const browser = await this.browser();
    try {
      return await this.syncPortfolio(browser, cookies);
    } finally {
      await browser.close();
    }
  }

  async enrichLead(leadId: string) {
    const lead = (await this.db.query<{ id: string; source: string; external_id: string | null; url: string | null }>(
      'SELECT id,source,external_id,url FROM leads WHERE id=$1', [leadId],
    )).rows[0];
    if (!lead || lead.source !== 'fl' || !lead.url || !lead.external_id || lead.external_id.startsWith('dialog:')) return { enriched: false };
    const cookiesRaw = await this.settings.getSecret('fl_cookies');
    const cookies = cookiesRaw ? JSON.parse(cookiesRaw) as CookieData[] : [];
    const detail = await this.readProject(lead.url, cookies);
    const files = await this.attachments.download(lead.external_id, detail.attachment_links);
      const project = {
        detail_parsed_at: new Date().toISOString(),
        published_at: detail.published_at,
        published_text: detail.published_text,
        client_registered: detail.client_registered,
        response_count: detail.response_count,
        response_price_min: detail.response_price_min,
        response_price_max: detail.response_price_max,
        response_days_min: detail.response_days_min,
        response_days_max: detail.response_days_max,
        age_minutes_at_parse: detail.age_minutes_at_parse,
        attachments: files,
      };
      await this.db.query(
        `UPDATE leads SET title=$2,description=$3,budget_text=$4,
         requirements=jsonb_set(requirements,'{project}',
           coalesce(requirements->'project','{}'::jsonb) || $5::jsonb,
           true),
         client=client || $6::jsonb,updated_at=now() WHERE id=$1`,
        [leadId, detail.title, detail.description, detail.budget, JSON.stringify(project), JSON.stringify(detail.client)],
      );
    return { enriched: true, attachments: files.length, responses: detail.response_count };
  }

  async syncChats() {
    const state = await this.flState();
    if (!state.enabled) return { chats: 0, messages: 0, drafts: 0, alerts: [], disabled: true };
    const cookiesRaw = await this.settings.getSecret('fl_cookies');
    if (!cookiesRaw) return { chats: 0, messages: 0, drafts: 0, alerts: [], disabled: true, reason: 'FL cookies не настроены' };
    const cookies = JSON.parse(cookiesRaw) as CookieData[];
    await this.checkCookieExpiry(cookies);
    const browser = await this.browser();
    let insertedMessages = 0;
    let queuedDrafts = 0;
    const alerts: Array<{ leadId: string; title: string; author: string; content: string }> = [];
    try {
      const page = await browser.newPage();
      await page.setCookie(...cookies);
      await page.goto('https://www.fl.ru/messages/', { waitUntil: 'networkidle2', timeout: 40_000 });
      await this.assertSession(page);
      // FL renders the chat list after navigation has already become network-idle.
      // Reading immediately intermittently produced a false, healthy "0 chats" result.
      await page.waitForSelector('[data-id^="qa-chat-list-item-"]', { timeout: 10_000 }).catch(() => undefined);
      const rawChats = await page.evaluate(() => Array.from(document.querySelectorAll('[data-id^="qa-chat-list-item-"]')).map((element) => {
        const profileLink = Array.from(element.querySelectorAll<HTMLAnchorElement>('a[href]'))
          .find((anchor) => /\/users\/[^/?#]+/iu.test(anchor.getAttribute('href') || anchor.href || ''));
        const profileImage = profileLink?.querySelector('img');
        return {
          dialogId: (element.getAttribute('data-id') || '').replace('qa-chat-list-item-', ''),
          title: element.querySelector('[data-id="qa-chat-card-title"]')?.textContent?.trim() || 'Диалог FL.ru',
          profileHref: profileLink?.getAttribute('href') || profileLink?.href || null,
          profileLabel: profileLink?.getAttribute('aria-label')
            || profileLink?.getAttribute('title')
            || profileImage?.getAttribute('alt')
            || profileLink?.textContent?.trim()
            || null,
        };
      }).filter((chat) => chat.dialogId));
      const chats = rawChats.map((chat) => ({
        ...chat,
        identity: flProfileIdentity(chat.profileHref, chat.profileLabel),
      }));
      const lastFullSync = state.cursor?.last_full_chat_sync_at || state.cursor?.cookie_last_verified_at;
      const lastFullSyncMs = lastFullSync ? Date.parse(lastFullSync) : 0;
      const fullSync = !lastFullSyncMs || Date.now() - lastFullSyncMs >= 6 * 60 * 60 * 1_000;
      const chatsToSync = fullSync ? chats.slice(0, 50) : chats.slice(0, 5);

      for (const [chatRank, chat] of chatsToSync.entries()) {
        const chatPage = await browser.newPage();
        try {
          await chatPage.setCookie(...cookies);
          await chatPage.goto(`https://www.fl.ru/messages/?dialogId=${encodeURIComponent(chat.dialogId)}&dialogType=offer`, { waitUntil: 'networkidle2', timeout: 40_000 });
          await this.assertSession(chatPage);
          await chatPage.waitForSelector('[id^="mes-"]', { timeout: 10_000 }).catch(() => undefined);
          const rawParsed = await chatPage.evaluate(() => Array.from(document.querySelectorAll('[id^="mes-"]')).map((element) => {
            const messageId = element.getAttribute('id') || '';
            const textElement = element.querySelector('.fl-message-text .text-pre-line, .fl-message-text .d-inline-block, .fl-message-text');
            const profileLink = Array.from(element.querySelectorAll<HTMLAnchorElement>('a[href]'))
              .find((anchor) => /\/users\/[^/?#]+/iu.test(anchor.getAttribute('href') || anchor.href || ''));
            const profileImage = profileLink?.querySelector('img');
            return {
              messageId,
              text: textElement?.textContent?.trim() || '',
              owner: Boolean(element.querySelector('.owner')),
              profileHref: profileLink?.getAttribute('href') || profileLink?.href || null,
              profileLabel: profileLink?.getAttribute('aria-label')
                || profileLink?.getAttribute('title')
                || profileImage?.getAttribute('alt')
                || profileLink?.textContent?.trim()
                || null,
            };
          }).filter((message) => message.messageId !== 'mes-end' && message.text));
          const parsed = rawParsed.map((message) => {
            const identity = flProfileIdentity(message.profileHref, message.profileLabel);
            return {
              messageId: message.messageId,
              text: message.text,
              owner: message.owner,
              author: message.owner ? 'owner' : identity.name || identity.username || 'client',
              identity,
            };
          });
          const result = await this.persistChat(chat.dialogId, chat.title, parsed, chatRank, chat.identity);
          insertedMessages += result.inserted;
          if (result.lastInboundId && result.lastDirection === 'inbound') {
            await this.push.notify(
              'Новое сообщение на FL.ru',
              chat.title,
              `/sales/?lead=${result.leadId}`,
            ).catch((error) => this.logger.warn(`Push skipped: ${error instanceof Error ? error.message : 'unknown'}`));
            await this.queue.add('draft-reply', {
              leadId: result.leadId,
              channel: 'fl',
              targetExternalId: chat.dialogId,
              mode: 'chat',
            }, `fl-chat-draft-${result.lastInboundId}`);
            queuedDrafts += 1;
            alerts.push({
              leadId: result.leadId,
              title: chat.title,
              author: result.lastInboundAuthor || 'Заказчик',
              content: result.lastInboundContent || '',
            });
          }
        } finally {
          await chatPage.close();
        }
      }
      await this.db.query(
        `UPDATE connector_state SET cursor=(cursor - 'cookie_auth_alert') || $2::jsonb,updated_at=now()
         WHERE connector=$1`,
        ['fl', JSON.stringify({
          cookie_last_verified_at: new Date().toISOString(),
          chat_list_count: chats.length,
          chat_checked_count: chatsToSync.length,
          ...(fullSync ? { last_full_chat_sync_at: new Date().toISOString() } : {}),
        })],
      );
      await this.settings.setConnectorState('fl', { healthy: true, statusText: `Чаты: ${chats.length}, новых сообщений: ${insertedMessages}`, success: true });
      return { chats: chats.length, messages: insertedMessages, drafts: queuedDrafts, alerts };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка FL.ru';
      if (message.includes('Сессия FL.ru недействительна') || message.includes('Cookies FL.ru истекли')) {
        await this.notifyCookieFailure(message);
      } else {
        await this.settings.setConnectorState('fl', { healthy: false, statusText: message.slice(0, 180) });
      }
      throw error;
    } finally {
      await browser.close();
    }
  }

  async cookieStatus() {
    const cookiesRaw = await this.settings.getSecret('fl_cookies');
    if (!cookiesRaw) return { configured: false, expiresAt: null, expiryKnown: false };
    const cookies = JSON.parse(cookiesRaw) as Array<CookieData & { expirationDate?: number }>;
    const session = cookies.find((cookie) => cookie.name === 'PHPSESSID');
    const expires = Number(session?.expires ?? session?.expirationDate);
    return {
      configured: true,
      expiresAt: Number.isFinite(expires) && expires > 0 ? new Date(expires * 1_000).toISOString() : null,
      expiryKnown: Number.isFinite(expires) && expires > 0,
    };
  }

  async sendResponse(input: { projectUrl: string; content: string; price?: number; days?: number }) {
    const cookies = await this.cookies();
    const browser = await this.browser();
    try {
      let projectUrl: URL;
      try {
        projectUrl = new URL(input.projectUrl);
      } catch {
        throw new OutboundPreflightError('layout_change', 'У заказа нет корректной ссылки FL.ru');
      }
      if (!['fl.ru', 'www.fl.ru'].includes(projectUrl.hostname)) {
        throw new OutboundPreflightError('layout_change', 'Ссылка заказа ведёт не на FL.ru');
      }
      const page = await browser.newPage();
      await page.setCookie(...cookies);
      await page.goto(projectUrl.toString(), { waitUntil: 'networkidle2', timeout: 40_000 });
      await this.assertSession(page);
      const existingOffer = await page.$eval('#my-offer', (element) => element.textContent || '')
        .catch(() => '');
      if (existingOffer) {
        if (!matchesExistingFlOffer(existingOffer, input.content)) {
          throw new OutboundPreflightError(
            'layout_change',
            'На FL.ru уже есть другой отклик на этот проект. Проверьте его вручную',
          );
        }
        await this.settings.setConnectorState('fl', {
          healthy: true,
          statusText: 'Отклик уже подтверждён на FL.ru',
          success: true,
        });
        return { ok: true, alreadySent: true };
      }
      const responseUrl = await page.$eval('a[href*="respond"]', (element) => (element as HTMLAnchorElement).href)
        .catch(() => '');
      if (responseUrl) {
        const target = new URL(responseUrl, projectUrl);
        if (!['fl.ru', 'www.fl.ru'].includes(target.hostname)) {
          throw new OutboundPreflightError('layout_change', 'Кнопка отклика ведёт за пределы FL.ru');
        }
        await page.goto(target.toString(), { waitUntil: 'networkidle2', timeout: 20_000 });
        await this.assertSession(page);
      }
      await page.waitForSelector('textarea[name="descr"]', { timeout: 15_000 }).catch((error) => {
        throw new OutboundPreflightError('layout_change', 'Форма отклика FL.ru не найдена: интерфейс изменился', { cause: error });
      });
      await page.$eval('textarea[name="descr"]', (el, value) => {
        const field = el as HTMLTextAreaElement;
        field.value = String(value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }, input.content);
      if (input.price) await this.setInput(page, 'input[name="cost_from"]', String(input.price));
      if (input.days) await this.setInput(page, 'input[name="time_from"]', String(input.days));
      const submit = await page.$('button[type="submit"]');
      if (!submit) throw new OutboundPreflightError('layout_change', 'Кнопка отправки FL.ru не найдена: интерфейс изменился');
      try {
        await submit.click();
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        const textarea = await page.$('textarea[name="descr"]');
        if (textarea) {
          const value = await page.$eval('textarea[name="descr"]', (el) => (el as HTMLTextAreaElement).value);
          if (value === input.content) {
            throw new OutboundDeliveryUnknownError('FL.ru не подтвердил отправку отклика; проверьте проект вручную');
          }
        }
      } catch (error) {
        if (error instanceof OutboundDeliveryUnknownError) throw error;
        throw new OutboundDeliveryUnknownError(
          'Соединение с FL.ru прервалось после нажатия «Отправить»; автоматический повтор запрещён',
          { cause: error },
        );
      }
      await this.settings.setConnectorState('fl', { healthy: true, statusText: 'Сессия активна', success: true });
      return { ok: true };
    } finally {
      await browser.close();
    }
  }

  async sendChatMessage(dialogId: string, content: string) {
    const cookies = await this.cookies();
    const browser = await this.browser();
    try {
      const page = await browser.newPage();
      await page.setCookie(...cookies);
      await page.goto(`https://www.fl.ru/messages/?dialogId=${encodeURIComponent(dialogId)}&dialogType=offer`, { waitUntil: 'networkidle2', timeout: 40_000 });
      await this.assertSession(page);
      const selector = 'textarea[placeholder*="Сообщение"], textarea.form-control, #message-text';
      await page.waitForSelector(selector, { timeout: 15_000 }).catch((error) => {
        throw new OutboundPreflightError('layout_change', 'Поле сообщения FL.ru не найдено: интерфейс изменился', { cause: error });
      });
      const before = await page.$$eval('[id^="mes-"]', (elements) => elements.length);
      await page.$eval(selector, (element, value) => {
        const field = element as HTMLTextAreaElement;
        field.value = String(value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }, content);
      const clicked = await page.$eval('[data-id="qa-button-send"]', (element) => {
        (element as HTMLElement).click();
        return true;
      }).catch(() => false);
      if (!clicked) throw new OutboundPreflightError('layout_change', 'Кнопка отправки чата FL.ru не найдена: интерфейс изменился');
      try {
        await page.waitForFunction((count, text) => {
          const field = document.querySelector('textarea[placeholder*="Сообщение"], textarea.form-control, #message-text') as HTMLTextAreaElement | null;
          return document.querySelectorAll('[id^="mes-"]').length > Number(count) || field?.value.trim() === '' || document.body.innerText.includes(String(text));
        }, { timeout: 15_000 }, before, content);
      } catch (error) {
        throw new OutboundDeliveryUnknownError(
          'FL.ru не подтвердил сообщение после нажатия «Отправить»; автоматический повтор запрещён',
          { cause: error },
        );
      }
      await this.settings.setConnectorState('fl', { healthy: true, statusText: 'Чат FL.ru активен', success: true });
      return { ok: true };
    } finally {
      await browser.close();
    }
  }

  private async persistChat(
    dialogId: string,
    title: string,
    parsed: Array<{
      messageId: string;
      text: string;
      owner: boolean;
      author: string;
      identity: FlProfileIdentity;
    }>,
    chatRank: number,
    chatIdentity: FlProfileIdentity = { name: null, username: null },
  ) {
    const messageIdentity = parsed.find((message) => !message.owner && (message.identity.name || message.identity.username))?.identity;
    const identity = {
      name: messageIdentity?.name || chatIdentity.name,
      username: messageIdentity?.username || chatIdentity.username,
    };
    const clientPatch = {
      fl_dialog_id: dialogId,
      fl_chat_rank: chatRank,
      ...(identity.name ? { fl_name: identity.name } : {}),
      ...(identity.username ? { fl_username: identity.username } : {}),
    };
    let lead = await this.db.query<{ id: string }>(
      `SELECT id FROM leads WHERE source='fl' AND (client->>'fl_dialog_id'=$1 OR lower(title)=lower($2)) ORDER BY updated_at DESC LIMIT 1`,
      [dialogId, title],
    );
    if (!lead.rows[0]) {
      lead = await this.db.query<{ id: string }>(
        `INSERT INTO leads(source,external_id,title,description,status,client)
         VALUES('fl',$1,$2,'Диалог FL.ru','contacted',$3)
         ON CONFLICT(source,external_id) DO UPDATE SET title=EXCLUDED.title,updated_at=now()
         RETURNING id`,
        [`dialog:${dialogId}`, title, JSON.stringify(clientPatch)],
      );
    } else {
      await this.db.query(`UPDATE leads SET client=client || $2::jsonb,updated_at=now() WHERE id=$1`, [lead.rows[0].id, JSON.stringify(clientPatch)]);
    }
    const leadId = lead.rows[0].id;
    await this.db.query(
      `INSERT INTO lead_channels(lead_id,channel,external_id,metadata)
       VALUES($1,'fl',$2,$3)
       ON CONFLICT(channel,external_id) DO UPDATE SET
         lead_id=EXCLUDED.lead_id,metadata=EXCLUDED.metadata,last_seen_at=now()`,
      [leadId, dialogId, JSON.stringify({ kind: 'dialog', title, chatRank })],
    );
    let inserted = 0;
    let lastInboundId: string | null = null;
    let lastInboundContent: string | null = null;
    let lastInboundAuthor: string | null = null;
    let lastDirection: 'inbound' | 'outbound' | null = null;
    for (const message of parsed) {
      const direction = message.owner ? 'outbound' : 'inbound';
      const result = await this.db.query<{ id: string }>(
        `INSERT INTO messages(lead_id,channel,external_id,direction,author,content,metadata)
         VALUES($1,'fl',$2,$3,$4,$5,$6)
         ON CONFLICT(channel,external_id) DO NOTHING RETURNING id`,
        [leadId, `${dialogId}:${message.messageId}`, direction, message.author, message.text, JSON.stringify({ dialog_id: dialogId })],
      );
      if (!result.rows[0]) continue;
      inserted += 1;
      lastDirection = direction;
      if (direction === 'inbound') {
        lastInboundId = result.rows[0].id;
        lastInboundContent = message.text;
        lastInboundAuthor = message.author;
      } else {
        lastInboundId = null;
        lastInboundContent = null;
        lastInboundAuthor = null;
      }
    }
    if (lastInboundId && lastDirection === 'inbound') {
      await this.db.transaction(async (client) => {
        await client.query(
          `UPDATE leads SET last_inbound_message_id=$2,
           status=CASE WHEN status IN ('new','qualified') THEN 'contacted' ELSE status END,
           pipeline_stage=CASE WHEN pipeline_stage IN ('new','qualified','outreach')
             THEN 'conversation' ELSE pipeline_stage END,
           updated_at=now() WHERE id=$1`,
          [leadId, lastInboundId],
        );
        await client.query("UPDATE drafts SET status='stale',updated_at=now() WHERE lead_id=$1 AND status='pending'", [leadId]);
      });
    }
    return { leadId, inserted, lastInboundId, lastDirection, lastInboundContent, lastInboundAuthor };
  }

  private async readProject(url: string, cookies: CookieData[]) {
    const cookie = flCookieHeader(cookies);
    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; FreelanceSales/2.0)',
        ...(cookie ? { cookie } : {}),
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`FL project HTTP ${response.status}`);
    const $ = cheerio.load(await response.text());
    const clean = (value: string | null | undefined) => String(value || '').replace(/\s+/g, ' ').trim();
    const bodyLines = $('body').text().split(/\n+/).map(clean).filter(Boolean);
    const body = bodyLines.join(' ');
    const title = clean($('h1').first().text());
    const description = clean($('.fl-project-content__description-text').first().text());
    if (!title || !description) throw new Error('FL project page is missing title or description');
    const budget = bodyLines.find((line) => line.startsWith('Бюджет:'))?.replace(/^Бюджет:\s*/, '') || '';
    const published = body.match(/Опубликован\s+(\d{2}\.\d{2}\.\d{4}\s+в\s+\d{2}:\d{2})/i)?.[1] || '';
    const registered = body.match(/Зарегистрирован:\s*([^|]{1,120}?)(?=\s+(?:Откликнулись|Бюджет|Опубликован|$))/i)?.[1]?.trim() || '';
    const responseMatch = body.match(/Откликнулись:\s*([\d\s]+)\s+фрилансер/i);
    const pricesMatch = body.match(/Цены:\s*от\s*([\d\s]+)\s*₽\s*до\s*([\d\s]+)\s*₽/i);
    const daysMatch = body.match(/Сроки:\s*от\s*([\d\s]+)\s*до\s*([\d\s]+)\s*д/i);

    const candidates: Array<{ url: string; name: string }> = [];
    const roots = $('.fl-project-content__description-text, [class*="attachment"], [class*="project-file"]');
    roots.find('a[href]').each((_, element) => {
      candidates.push({ url: $(element).attr('href') || '', name: clean($(element).text()) });
    });
    roots.find('img[src]').each((_, element) => {
      candidates.push({ url: $(element).attr('src') || '', name: clean($(element).attr('alt')) });
    });
    const profileLink = $('a[href]').filter((_, element) =>
      /\/users\/[^/?#]+\/?(?:[?#].*)?$/iu.test($(element).attr('href') || ''),
    ).first();
    const profileHref = profileLink.attr('href') || null;
    const profileLabel = profileLink.attr('aria-label')
      || profileLink.attr('title')
      || profileLink.find('img').attr('alt')
      || clean(profileLink.text())
      || null;
    const publishedAt = this.parseFlDate(published);
    const identity = flProfileIdentity(profileHref, profileLabel);
    const number = (value: string | undefined) => value ? Number(value.replace(/\s+/g, '')) : null;
    const attachmentLinks = candidates.filter((item) => {
      try {
        const candidate = new URL(item.url, url);
        return (candidate.hostname === 'st.fl.ru' || candidate.hostname.endsWith('.fl.ru'))
          && /\/upload\/|download|attachment|\/file/i.test(candidate.pathname)
          && !candidate.pathname.includes('/about/documents/');
      } catch {
        return false;
      }
    }).map((item) => ({ ...item, url: new URL(item.url, url).toString() }))
      .filter((item, index, items) => items.findIndex((other) => other.url === item.url) === index);

    return {
      title,
      description,
      budget,
      published_at: publishedAt?.toISOString() || null,
      published_text: published || null,
      client_registered: registered || null,
      response_count: number(responseMatch?.[1]),
      response_price_min: number(pricesMatch?.[1]),
      response_price_max: number(pricesMatch?.[2]),
      response_days_min: number(daysMatch?.[1]),
      response_days_max: number(daysMatch?.[2]),
      age_minutes_at_parse: publishedAt ? Math.max(0, Math.round((Date.now() - publishedAt.getTime()) / 60_000)) : null,
      client: {
        ...(identity.name ? { fl_name: identity.name } : {}),
        ...(identity.username ? { fl_username: identity.username } : {}),
      },
      attachment_links: attachmentLinks,
    };
  }

  private async syncPortfolio(browser: Browser, cookies: CookieData[]) {
    let profile = await this.settings.getPublic<{ username?: string; url?: string }>('fl_portfolio_profile');
    if (!profile?.username) {
      const page = await browser.newPage();
      try {
        await page.setCookie(...cookies);
        const portfolioLogin = String((await this.settings.getPublic<{ login?: string }>('fl_account'))?.login
          || process.env.FL_LOGIN || '').trim();
        if (!portfolioLogin) throw new Error('Не задан логин FL для синхронизации портфолио');
        // /my_portfolio/ does not exist on FL.ru and answers 404.
        await page.goto(`https://www.fl.ru/users/${encodeURIComponent(portfolioLogin)}/portfolio/`, { waitUntil: 'networkidle2', timeout: 40_000 });
        await this.assertSession(page);
        const path = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
          .map((element) => element.getAttribute('href') || '')
          .find((href) => /^\/users\/[^/]+\/portfolio\/$/.test(href)) || '');
        const username = path.match(/^\/users\/([^/]+)\/portfolio\/$/)?.[1];
        if (!username) throw new Error('Профиль портфолио FL.ru не найден');
        profile = { username, url: `https://www.fl.ru/users/${username}/portfolio/` };
        await this.settings.setPublic('fl_portfolio_profile', profile);
      } finally {
        await page.close();
      }
    }
    const response = await fetch(profile.url!, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; FreelanceSales/2.0)' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`FL portfolio HTTP ${response.status}`);
    const $ = cheerio.load(await response.text());
    const urls = $('.portfolio-item__description[href*="/portfolio/"]').map((_, element) => new URL($(element).attr('href') || '', 'https://www.fl.ru').toString()).get();
    const uniqueUrls = [...new Set(urls)].slice(0, 120); // was 40: the owner has 87 published works
    const storedCases = await this.settings.getPublic<Array<Record<string, unknown>>>('fl_portfolio_cases') || [];
    const storedByUrl = new Map(storedCases.map((item) => [String(item.url || ''), item]));
    const cases: Array<Record<string, unknown>> = [];
    for (const caseUrl of uniqueUrls) {
      const caseResponse = await fetch(caseUrl, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; FreelanceSales/2.0)' }, signal: AbortSignal.timeout(25_000) });
      if (!caseResponse.ok) continue;
      const casePage = cheerio.load(await caseResponse.text());
      const title = casePage('.fl-portfolio-content-header__text').first().text().replace(/\s+/g, ' ').trim();
      const description = casePage('.fl-portfolio-content-text').first().text().replace(/\s+/g, ' ').trim();
      if (title && description) {
        const stored = storedByUrl.get(caseUrl) || {};
        cases.push({
          title,
          description: description.slice(0, 8_000),
          url: caseUrl,
          client_context: String(stored.client_context || title).slice(0, 1_000),
          task: String(stored.task || description).slice(0, 2_000),
          solution_details: String(stored.solution_details || '').slice(0, 2_000),
          challenge: String(stored.challenge || '').slice(0, 2_000),
          result: String(stored.result || '').slice(0, 1_000),
          stack: String(stored.stack || '').slice(0, 600),
          stack_mismatch_note: String(stored.stack_mismatch_note || '').slice(0, 600),
        });
      }
    }
    await this.settings.setPublic('fl_portfolio_cases', cases);
    await this.db.query(
      `UPDATE connector_state SET cursor=cursor || $2::jsonb,updated_at=now() WHERE connector=$1`,
      ['fl', JSON.stringify({ portfolio_last_sync_at: new Date().toISOString(), portfolio_case_count: cases.length })],
    );
    return { cases: cases.length };
  }

  private parseFlDate(value: string) {
    const match = value.match(/(\d{2})\.(\d{2})\.(\d{4})\s+в\s+(\d{2}):(\d{2})/);
    if (!match) return null;
    const [, day, month, year, hour, minute] = match;
    const time = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 3, Number(minute));
    return new Date(time);
  }

  private async cookies() {
    const cookiesRaw = await this.settings.getSecret('fl_cookies');
    if (!cookiesRaw) throw new Error('Cookies FL.ru не настроены');
    return JSON.parse(cookiesRaw) as CookieData[];
  }

  private async checkCookieExpiry(cookies: CookieData[]) {
    const session = (cookies as Array<CookieData & { expirationDate?: number }>).find((cookie) => cookie.name === 'PHPSESSID');
    const expires = Number(session?.expires ?? session?.expirationDate);
    const expiresAt = Number.isFinite(expires) && expires > 0 ? new Date(expires * 1_000) : null;
    await this.db.query(
      `UPDATE connector_state SET cursor=cursor || $2::jsonb,updated_at=now() WHERE connector=$1`,
      ['fl', JSON.stringify({
        cookie_expires_at: expiresAt?.toISOString() || null,
        cookie_expiry_known: Boolean(expiresAt),
        cookie_checked_at: new Date().toISOString(),
      })],
    );
    if (!expiresAt) return;
    const remainingMs = expiresAt.getTime() - Date.now();
    if (remainingMs <= 0) {
      await this.notifyCookieFailure('Cookies FL.ru истекли');
      throw new Error('Cookies FL.ru истекли');
    }
    if (remainingMs <= 24 * 60 * 60 * 1_000) {
      await this.notifyCookieAlert(
        `expiring:${expiresAt.toISOString()}`,
        'Cookies FL.ru скоро истекут',
        `Обновите cookies до ${expiresAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`,
        'cookie_expiry_alert',
      );
    }
  }

  private async notifyCookieFailure(message: string) {
    await this.settings.setConnectorState('fl', {
      healthy: false,
      statusText: 'Cookies FL.ru истекли или сессия недействительна',
    });
    await this.notifyCookieAlert('invalid', 'Нужно обновить cookies FL.ru', message);
  }

  private async notifyCookieAlert(
    key: string,
    title: string,
    body: string,
    field: 'cookie_auth_alert' | 'cookie_expiry_alert' = 'cookie_auth_alert',
  ) {
    const result = await this.db.query<{ alert: string | null }>(
      `SELECT cursor->>$2 AS alert FROM connector_state WHERE connector=$1`,
      ['fl', field],
    );
    if (result.rows[0]?.alert === key) return;
    await this.push.notify(title, body, '/sales/?page=settings')
      .catch((error) => this.logger.warn(`Push skipped: ${error instanceof Error ? error.message : 'unknown'}`));
    await this.db.query(
      `UPDATE connector_state SET cursor=cursor || $2::jsonb,updated_at=now() WHERE connector=$1`,
      ['fl', JSON.stringify({ [field]: key })],
    );
  }

  private async flState() {
    const result = await this.db.query<{ enabled: boolean; cursor: { shadow_until?: string; cookie_last_verified_at?: string; last_full_chat_sync_at?: string; portfolio_last_sync_at?: string; seen_project_ids?: string[] } }>(
      'SELECT enabled,cursor FROM connector_state WHERE connector=$1', ['fl'],
    );
    const state = result.rows[0] || { enabled: false, cursor: {} };
    const until = state.cursor?.shadow_until ? Date.parse(state.cursor.shadow_until) : null;
    if (state.enabled && until && Number.isFinite(until) && Date.now() >= until) {
      await this.db.query("UPDATE connector_state SET enabled=false,status_text='Суточный тест завершён',updated_at=now() WHERE connector='fl'");
      return { enabled: false, cursor: state.cursor };
    }
    return state;
  }

  private browser() {
    return puppeteer.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }

  private async assertSession(page: import('puppeteer-core').Page) {
    const pageText = await page.$eval('body', (element) => (element.textContent || '').toLowerCase()).catch(() => '');
    const captcha = await page.$('iframe[src*="captcha"], [class*="captcha"], [id*="captcha"], input[name*="captcha"]');
    if (captcha || /(?:я не робот|подтвердите, что вы не робот|captcha|капча)/iu.test(pageText)) {
      throw new OutboundPreflightError('captcha', 'FL.ru запросил CAPTCHA — требуется владелец');
    }
    if (page.url().includes('/login')) throw new OutboundPreflightError('authentication', 'Сессия FL.ru недействительна');
    const uid = await page.$eval('meta[name="current-uid"]', (element) => element.getAttribute('content')).catch(() => null);
    const hasMessages = await page.$('[data-id^="qa-chat-list-item-"], [id^="mes-"], textarea[placeholder*="Сообщение"]');
    if (!uid && !hasMessages) {
      throw new OutboundPreflightError('layout_change', 'Сессия FL.ru недействительна или интерфейс изменился');
    }
  }

  private async setInput(page: import('puppeteer-core').Page, selector: string, value: string) {
    const field = await page.$(selector);
    if (!field) return;
    await page.$eval(selector, (element, nextValue) => {
      const input = element as HTMLInputElement;
      input.value = String(nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }
}
