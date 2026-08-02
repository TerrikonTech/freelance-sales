import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { OutboundDeliveryUnknownError } from './outbound-errors';
import { QueueService } from './queue.service';
import { SalesAgentService } from './sales-agent.service';
import { SettingsService } from './settings.service';

export function telegramOnDemandOnly(value = process.env.TELEGRAM_ON_DEMAND_ONLY): boolean {
  return !/^(?:0|false|off|no)$/i.test(String(value || 'true').trim());
}

export function shouldQueueAutomaticTelegramDraft(
  live: boolean,
  value = process.env.TELEGRAM_ON_DEMAND_ONLY,
): boolean {
  return live && !telegramOnDemandOnly(value);
}

@Injectable()
export class TelegramService {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly queue: QueueService,
    private readonly agent: SalesAgentService,
  ) {}

  async configureWebhook() {
    const token = await this.settings.getSecret('telegram_bot_token');
    const secret = await this.settings.getSecret('telegram_webhook_secret');
    const publicUrl = process.env.PUBLIC_URL;
    if (!token || !secret || !publicUrl) throw new Error('Telegram или PUBLIC_URL не настроены');
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${publicUrl}/api/connectors/telegram/webhook`,
        secret_token: secret,
        allowed_updates: [
          'message',
          'edited_message',
          'business_connection',
          'business_message',
          'edited_business_message',
          'deleted_business_messages',
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json() as { ok?: boolean; description?: string };
    if (!body.ok) throw new Error(body.description || `Telegram HTTP ${response.status}`);
    await this.settings.setConnectorState('telegram', { enabled: true, healthy: true, statusText: 'Webhook подключён', success: true });
    return { ok: true };
  }

  async verifyWebhookSecret(header: string | undefined) {
    const expected = await this.settings.getSecret('telegram_webhook_secret');
    return Boolean(expected && header && expected === header);
  }

  async processUpdate(update: Record<string, any>) {
    const ownerMessage = update.message || update.edited_message;
    if (ownerMessage?.chat?.id) {
      const owner = await this.settings.getPublic<{ id?: number }>('telegram_owner');
      if (owner?.id && Number(ownerMessage.from?.id) === Number(owner.id)) {
        await this.queue.add(
          'owner-command',
          { message: ownerMessage },
          `owner-command-${String(ownerMessage.chat.id)}-${String(ownerMessage.message_id)}`,
        );
      }
      return;
    }
    if (update.business_connection) {
      const connection = update.business_connection;
      await this.settings.setSecret('telegram_business_connection_id', String(connection.id));
      await this.settings.setPublic('telegram_owner', { id: connection.user?.id, username: connection.user?.username || null });
      await this.settings.setConnectorState('telegram', { enabled: true, healthy: true, statusText: 'Business-аккаунт подключён', success: true });
      return;
    }
    const message = update.business_message || update.edited_business_message;
    if (!message?.chat?.id || !message.text) return;
    const owner = await this.settings.getPublic<{ id?: number }>('telegram_owner');
    const outbound = owner?.id && message.from?.id === owner.id;
    const chatId = String(message.chat.id);
    const externalLeadId = `telegram:${chatId}`;
    const linkedLeadId = await this.agent.resolveTelegramLead(chatId, message.text);
    let leadId = linkedLeadId;
    if (!leadId) {
      const lead = await this.db.query<{ id: string }>(
        `SELECT COALESCE(
           (SELECT lead_id FROM lead_channels WHERE channel='telegram' AND external_id=$1),
           (SELECT id FROM leads WHERE source='telegram' AND external_id=$2)
         ) AS id`,
        [chatId, externalLeadId],
      );
      leadId = lead.rows[0]?.id || null;
    }
    if (!leadId) {
      const created = await this.db.query<{ id: string }>(
        `INSERT INTO leads(source,external_id,title,description,status,client)
         VALUES('telegram',$1,$2,'Диалог из Telegram','contacted',$3) RETURNING id`,
        [externalLeadId, `Telegram: ${message.chat.first_name || message.chat.username || chatId}`, JSON.stringify({ telegram_chat_id: chatId, username: message.chat.username || null })],
      );
      leadId = created.rows[0].id;
    }
    await this.agent.registerLeadChannel(leadId, 'telegram', chatId);
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO messages(lead_id,channel,external_id,direction,author,content,metadata)
       VALUES($1,'telegram',$2,$3,$4,$5,$6)
       ON CONFLICT(channel,external_id) DO NOTHING RETURNING id`,
      [
        leadId,
        `${chatId}:${String(message.message_id)}`,
        outbound ? 'outbound' : 'inbound',
        message.from?.first_name || null,
        message.text,
        JSON.stringify({ date: message.date, transport: 'bot_api' }),
      ],
    );
    if (!inserted.rows[0]) return;
    if (!outbound) {
      await this.db.transaction(async (client) => {
        await client.query(
          `UPDATE leads SET last_inbound_message_id=$2,
           pipeline_stage=CASE WHEN pipeline_stage IN ('new','qualified','outreach','conversation','telegram_handoff')
             THEN 'discovery' ELSE pipeline_stage END,
           client=client || $3::jsonb,updated_at=now() WHERE id=$1`,
          [
            leadId,
            inserted.rows[0].id,
            JSON.stringify({
              telegram_chat_id: chatId,
              telegram_username: message.chat.username || null,
            }),
          ],
        );
        await client.query("UPDATE drafts SET status='stale',updated_at=now() WHERE lead_id=$1 AND status='pending'", [leadId]);
      });
      if (shouldQueueAutomaticTelegramDraft(true)) {
        await this.queue.add(
          'draft-reply',
          { leadId, channel: 'telegram', targetExternalId: chatId },
          `tg-draft-${inserted.rows[0].id}`,
        );
      }
    }
  }

  async ingestMtprotoMessages(
    items: Array<{
      chatId?: string | number;
      messageId?: string | number;
      direction?: string;
      text?: string;
      label?: string;
      createdAt?: string | number;
      live?: boolean;
      voice?: boolean;
    }>,
  ) {
    let insertedCount = 0;
    let queuedCount = 0;
    for (const item of items.slice(0, 500)) {
      const chatId = String(item.chatId || '').trim();
      const messageId = String(item.messageId || '').trim();
      const text = String(item.text || '').trim().slice(0, 8_000);
      const direction = item.direction === 'outbound' ? 'outbound' : 'inbound';
      if (!chatId || !messageId || !text) continue;
      const linked = await this.db.query<{ id: string }>(
        `SELECT COALESCE(
           (SELECT lead_id FROM lead_channels WHERE channel='telegram' AND external_id=$1),
           (SELECT id FROM leads WHERE source='telegram' AND external_id=$2)
         ) AS id`,
        [chatId, `telegram:${chatId}`],
      );
      let leadId = linked.rows[0]?.id || null;
      if (!leadId) {
        const created = await this.db.query<{ id: string }>(
          `INSERT INTO leads(source,external_id,title,description,status,client,pipeline_stage)
           VALUES('telegram',$1,$2,'Диалог из Telegram','contacted',$3,'conversation')
           ON CONFLICT(source,external_id) DO UPDATE SET
             title=EXCLUDED.title,client=leads.client || EXCLUDED.client,updated_at=now()
           RETURNING id`,
          [
            `telegram:${chatId}`,
            String(item.label || `Telegram: ${chatId}`).slice(0, 300),
            JSON.stringify({ telegram_chat_id: chatId }),
          ],
        );
        leadId = created.rows[0].id;
      }
      await this.agent.registerLeadChannel(leadId, 'telegram', chatId);
      const inserted = await this.db.query<{ id: string }>(
        `INSERT INTO messages(
           lead_id,channel,external_id,direction,author,content,metadata,created_at
         ) VALUES($1,'telegram',$2,$3,$4,$5,$6,
           CASE WHEN $7::text ~ '^[0-9]+$'
             THEN to_timestamp($7::double precision) ELSE now() END)
         ON CONFLICT(channel,external_id) DO NOTHING RETURNING id`,
        [
          leadId,
          `${chatId}:${messageId}`,
          direction,
          String(item.label || '').slice(0, 200) || null,
          text,
          JSON.stringify({ transport: 'mtproto', voice: item.voice === true }),
          String(item.createdAt || ''),
        ],
      );
      if (!inserted.rows[0]) continue;
      insertedCount += 1;
      if (direction === 'inbound') {
        await this.db.transaction(async (client) => {
          await client.query(
            `UPDATE leads SET last_inbound_message_id=$2,
             pipeline_stage=CASE WHEN pipeline_stage IN (
               'new','qualified','outreach','conversation','telegram_handoff'
             ) THEN 'discovery' ELSE pipeline_stage END,
             client=client || $3::jsonb,updated_at=now() WHERE id=$1`,
            [leadId, inserted.rows[0].id, JSON.stringify({ telegram_chat_id: chatId })],
          );
          await client.query(
            "UPDATE drafts SET status='stale',updated_at=now() WHERE lead_id=$1 AND status='pending'",
            [leadId],
          );
        });
        if (shouldQueueAutomaticTelegramDraft(item.live === true)) {
          await this.queue.add(
            'draft-reply',
            { leadId, channel: 'telegram', targetExternalId: chatId },
            `mtproto-draft-${inserted.rows[0].id}`,
          );
          queuedCount += 1;
        }
      }
    }
    return { inserted: insertedCount, queued: queuedCount };
  }

  async processOwnerMessage(message: Record<string, any>) {
    const owner = await this.settings.getPublic<{ id?: number }>('telegram_owner');
    if (!owner?.id || Number(message.from?.id) !== Number(owner.id)) return;
    const ownerId = String(owner.id);
    const chatId = String(message.chat.id);
    const text = String(message.text || message.caption || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      await this.sendControlMessage(
        chatId,
        'Голосовое получено, но единый агент пока не получил его расшифровку. Напишите команду текстом.',
      );
      return;
    }
    if (/^\/(?:start|help)\b/i.test(text)) {
      await this.sendControlMessage(
        chatId,
        'Я работаю только по вашей команде. Входящие сообщения сохраняю, но сам ничего не генерирую и не отправляю. Пишите обычными словами: «покажи клиентов», «работаем с СОУС», «что он хотел сегодня?», «подготовь ответ клиенту …». Для отправки нужен отдельный приказ «отправь».',
      );
      return;
    }
    if (
      /^\/(?:clients|клиенты)\b/i.test(text)
      || /^(?:покажи|список)\s+клиент/i.test(text)
    ) {
      await this.sendControlMessage(chatId, this.formatLeadMatches(await this.agent.recentLeads(12)));
      return;
    }
    if (/^(?:обзор|сводка|что\s+нового|что\s+важного|приоритеты)(?:\s|$)/i.test(text)) {
      try {
        const result = await this.agent.answerOwnerOverview(text);
        await this.sendControlMessage(chatId, result.answer);
      } catch (error) {
        await this.sendControlMessage(
          chatId,
          error instanceof Error ? error.message : 'Не удалось подготовить обзор',
        );
      }
      return;
    }
    const select = text.match(/^(?:работаем\s+с|выбери(?:\s+клиента)?|клиент)\s+(.+)$/i);
    if (select) {
      const result = await this.agent.selectOwnerLead(ownerId, select[1]);
      if (result.selected) {
        await this.sendControlMessage(
          chatId,
          `Выбран клиент: ${result.selected.title}. Теперь задавайте вопросы или попросите подготовить ответ.`,
        );
      } else {
        await this.sendControlMessage(
          chatId,
          result.matches.length
            ? `Нашёл несколько вариантов:\n${this.formatLeadMatches(result.matches)}\nУточните название.`
            : 'Клиента по такому запросу не нашёл.',
        );
      }
      return;
    }
    if (/^(?:отправь|отправляем|да,?\s*отправь|подтверждаю\s+отправку)[.!\s]*$/i.test(text)) {
      try {
        await this.agent.approveOwnerOutbound(ownerId);
        await this.sendControlMessage(
          chatId,
          'Ответ одобрен и поставлен на отправку. Результат фиксируется в журнале сделки.',
        );
      } catch (error) {
        await this.sendControlMessage(
          chatId,
          error instanceof Error ? error.message : 'Не удалось отправить ответ',
        );
      }
      return;
    }
    const outbound = text.match(
      /^(?:подготовь|напиши|скажи)\s+(?:ответ\s+)?(?:заказчику|клиенту)[,:]?\s*(.+)$/i,
    );
    if (outbound) {
      try {
        const prepared = await this.agent.prepareOwnerOutbound(ownerId, outbound[1]);
        await this.sendControlMessage(
          chatId,
          `Черновик для «${prepared.leadTitle}»:\n\n${prepared.content}\n\nЕсли всё верно, напишите отдельным сообщением «отправь».`,
        );
      } catch (error) {
        await this.sendControlMessage(
          chatId,
          error instanceof Error ? error.message : 'Не удалось подготовить ответ',
        );
      }
      return;
    }
    const lead = await this.agent.ownerLead(ownerId);
    if (!lead) {
      try {
        const result = await this.agent.answerOwnerOverview(text);
        await this.sendControlMessage(chatId, result.answer);
      } catch (error) {
        await this.sendControlMessage(
          chatId,
          error instanceof Error
            ? error.message
            : `Сначала выберите клиента фразой «работаем с …».\n${this.formatLeadMatches(await this.agent.recentLeads(8))}`,
        );
      }
      return;
    }
    try {
      const result = await this.agent.answerOwner(lead.id, text);
      await this.sendControlMessage(chatId, result.answer);
    } catch (error) {
      await this.sendControlMessage(
        chatId,
        error instanceof Error ? error.message : 'Не удалось проанализировать переписку',
      );
    }
  }

  async notifyOwnerDraft(
    leadId: string,
    draftId: string,
    leadTitle: string,
    content: string,
  ) {
    if (telegramOnDemandOnly()) {
      return { sent: false, reason: 'on_demand_only' };
    }
    const owner = await this.settings.getPublic<{ id?: number }>('telegram_owner');
    if (!owner?.id) return { sent: false };
    await this.db.query(
      `INSERT INTO owner_agent_sessions(
         owner_external_id,active_lead_id,pending_draft_id,updated_at
       ) VALUES($1,$2,$3,now())
       ON CONFLICT(owner_external_id) DO UPDATE SET
         active_lead_id=EXCLUDED.active_lead_id,
         pending_draft_id=EXCLUDED.pending_draft_id,updated_at=now()`,
      [String(owner.id), leadId, draftId],
    );
    await this.sendControlMessage(
      String(owner.id),
      `Нужен ваш ответ клиенту «${leadTitle}»:\n\n${content.slice(0, 3000)}\n\nЕсли всё верно, напишите отдельным сообщением «отправь». Если нужно изменить — напишите «подготовь ответ клиенту …».`,
    );
    return { sent: true };
  }

  async sendBusinessMessage(chatId: string, content: string) {
    const token = await this.settings.getSecret('telegram_bot_token');
    const connectionId = await this.settings.getSecret('telegram_business_connection_id');
    if (!token || !connectionId) throw new Error('Telegram Business не подключён');
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ business_connection_id: connectionId, chat_id: chatId, text: content }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new OutboundDeliveryUnknownError(
        'Telegram не подтвердил результат отправки; автоматический повтор запрещён',
        { cause: error },
      );
    }
    let body: { ok?: boolean; description?: string; result?: { message_id?: number } };
    try {
      body = await response.json() as typeof body;
    } catch (error) {
      if (response.ok) {
        throw new OutboundDeliveryUnknownError(
          'Telegram вернул неразбираемый успешный ответ; проверьте чат вручную',
          { cause: error },
        );
      }
      throw new Error(`Telegram HTTP ${response.status}`);
    }
    if (!body.ok) throw new Error(body.description || `Telegram HTTP ${response.status}`);
    return { externalId: body.result?.message_id ? String(body.result.message_id) : null };
  }

  private async sendControlMessage(chatId: string, text: string) {
    const token = await this.settings.getSecret('telegram_bot_token');
    if (!token) throw new Error('Telegram-бот не настроен');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4_000) }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json() as { ok?: boolean; description?: string };
    if (!body.ok) throw new Error(body.description || `Telegram HTTP ${response.status}`);
  }

  private formatLeadMatches(rows: Array<Record<string, any>>) {
    if (!rows.length) return 'Активных клиентов пока нет.';
    return rows.slice(0, 12).map(
      (row, index) =>
        `${index + 1}. ${String(row.title || 'Без названия')} · ${String(row.pipeline_stage || 'new')}`,
    ).join('\n');
  }
}
