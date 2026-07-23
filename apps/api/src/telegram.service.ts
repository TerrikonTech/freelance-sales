import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { QueueService } from './queue.service';
import { SettingsService } from './settings.service';

@Injectable()
export class TelegramService {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly queue: QueueService,
  ) {}

  async configureWebhook() {
    const token = await this.settings.getSecret('telegram_bot_token');
    const secret = await this.settings.getSecret('telegram_webhook_secret');
    const publicUrl = process.env.PUBLIC_URL;
    if (!token || !secret || !publicUrl) throw new Error('Telegram или PUBLIC_URL не настроены');
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${publicUrl}/api/connectors/telegram/webhook`, secret_token: secret, allowed_updates: ['business_connection','business_message','edited_business_message','deleted_business_messages'] }),
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
    let lead = await this.db.query<{ id: string }>('SELECT id FROM leads WHERE source=$1 AND external_id=$2', ['telegram', externalLeadId]);
    if (!lead.rows[0]) {
      lead = await this.db.query<{ id: string }>(
        `INSERT INTO leads(source,external_id,title,description,status,client)
         VALUES('telegram',$1,$2,'Диалог из Telegram','contacted',$3) RETURNING id`,
        [externalLeadId, `Telegram: ${message.chat.first_name || message.chat.username || chatId}`, JSON.stringify({ telegram_chat_id: chatId, username: message.chat.username || null })],
      );
    }
    const leadId = lead.rows[0].id;
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO messages(lead_id,channel,external_id,direction,author,content,metadata)
       VALUES($1,'telegram',$2,$3,$4,$5,$6)
       ON CONFLICT(channel,external_id) DO NOTHING RETURNING id`,
      [leadId, String(message.message_id), outbound ? 'outbound' : 'inbound', message.from?.first_name || null, message.text, JSON.stringify({ date: message.date })],
    );
    if (!inserted.rows[0]) return;
    if (!outbound) {
      await this.db.transaction(async (client) => {
        await client.query('UPDATE leads SET last_inbound_message_id=$2,updated_at=now() WHERE id=$1', [leadId, inserted.rows[0].id]);
        await client.query("UPDATE drafts SET status='stale',updated_at=now() WHERE lead_id=$1 AND status='pending'", [leadId]);
      });
      await this.queue.add('draft-reply', { leadId, channel: 'telegram', targetExternalId: chatId }, `tg-draft-${inserted.rows[0].id}`);
    }
  }

  async sendBusinessMessage(chatId: string, content: string) {
    const token = await this.settings.getSecret('telegram_bot_token');
    const connectionId = await this.settings.getSecret('telegram_business_connection_id');
    if (!token || !connectionId) throw new Error('Telegram Business не подключён');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ business_connection_id: connectionId, chat_id: chatId, text: content }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json() as { ok?: boolean; description?: string; result?: { message_id?: number } };
    if (!body.ok) throw new Error(body.description || `Telegram HTTP ${response.status}`);
    return { externalId: body.result?.message_id ? String(body.result.message_id) : null };
  }
}
