import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { DatabaseService } from './database.service';
import { QueueService } from './queue.service';
import { SalesAgentService } from './sales-agent.service';
import { buildSandboxSteps, isSandboxLead, SANDBOX_SCENARIOS, SandboxScenario } from './sandbox';
import { TelegramService } from './telegram.service';

@Injectable()
export class SandboxService {
  constructor(
    private readonly db: DatabaseService,
    private readonly queue: QueueService,
    private readonly salesAgent: SalesAgentService,
    private readonly telegram: TelegramService,
  ) {}

  async create(scenario: string) {
    const key = Object.prototype.hasOwnProperty.call(SANDBOX_SCENARIOS, scenario)
      ? scenario as SandboxScenario
      : 'web_service';
    const preset = SANDBOX_SCENARIOS[key];
    const suffix = randomBytes(6).toString('hex');
    const created = await this.db.query<{ id: string }>(
      `INSERT INTO leads(source,external_id,title,description,budget_text,client,next_action)
       VALUES('sandbox',$1,$2,$3,$4,$5,'Дождаться тестовой оценки') RETURNING id`,
      [
        `sandbox-project-${suffix}`,
        `[ТЕСТ] ${preset.title}`,
        preset.description,
        preset.budgetText,
        JSON.stringify({ sandbox: true, scenario: key, name: 'Тестовый заказчик' }),
      ],
    );
    const leadId = created.rows[0].id;
    await this.db.query(
      "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'sandbox','sandbox_created',$2)",
      [leadId, JSON.stringify({ scenario: key, externalWritesBlocked: true })],
    );
    await this.queue.add('analyze-lead', { leadId, force: true }, `sandbox-analyze-${leadId}`);
    return { id: leadId, scenario: key };
  }

  async list() {
    return (await this.db.query(
      `SELECT l.id,l.title,l.status,l.score,l.pipeline_stage,l.discovery_readiness,l.build_readiness,
              l.next_action,l.created_at,l.updated_at,
              (SELECT count(*)::int FROM messages m WHERE m.lead_id=l.id) AS messages,
              (SELECT count(*)::int FROM drafts d WHERE d.lead_id=l.id) AS drafts,
              (SELECT count(*)::int FROM documents d WHERE d.lead_id=l.id) AS documents,
              (SELECT count(*)::int FROM design_assets a WHERE a.lead_id=l.id) AS designs
       FROM leads l WHERE l.source='sandbox' AND l.client->>'sandbox'='true'
       ORDER BY l.created_at DESC LIMIT 20`,
    )).rows;
  }

  async state(id: string) {
    const lead = await this.sandboxLead(id);
    const [messages, drafts, requirements, documents, designs, handoffs, deliveries, activities, turns, channels, tasks] = await Promise.all([
      this.db.query('SELECT id,channel,direction,author,content,metadata,created_at FROM messages WHERE lead_id=$1 ORDER BY created_at', [id]),
      this.db.query(`SELECT id,kind,channel,content,status,error,metadata,created_at,updated_at
        FROM drafts WHERE lead_id=$1 ORDER BY created_at DESC`, [id]),
      this.db.query(`SELECT category,slug,title,value,status,required,confidence,source_message_id,updated_at
        FROM sales_requirements WHERE lead_id=$1 ORDER BY required DESC,category,slug`, [id]),
      this.db.query(`SELECT id,kind,version,status,markdown,metadata,(file_path IS NOT NULL) AS downloadable,created_at,updated_at
        FROM documents WHERE lead_id=$1 ORDER BY created_at DESC`, [id]),
      this.db.query('SELECT id,bytes,sha256,metadata,created_at FROM design_assets WHERE lead_id=$1 ORDER BY created_at', [id]),
      this.db.query(`SELECT token,status,from_channel,to_channel,target_external_id,expires_at,used_at,created_at
        FROM conversation_handoffs WHERE lead_id=$1 ORDER BY created_at`, [id]),
      this.db.query(`SELECT id,status,channel,target_external_id,external_id,error,attempt_count,attempted_at,completed_at,created_at
        FROM outbound_deliveries WHERE lead_id=$1 ORDER BY created_at`, [id]),
      this.db.query('SELECT actor,action,details,created_at FROM activities WHERE lead_id=$1 ORDER BY created_at LIMIT 160', [id]),
      this.db.query(`SELECT id,channel,stage_before,stage_after,intent,reply,summary,decision,created_at
        FROM agent_turns WHERE lead_id=$1 ORDER BY created_at`, [id]),
      this.db.query(`SELECT channel,external_id,metadata,linked_at,last_seen_at
        FROM lead_channels WHERE lead_id=$1 ORDER BY linked_at`, [id]),
      this.db.query(`SELECT id,kind,status,error,created_at,claimed_at,completed_at
        FROM ai_tasks WHERE payload->>'leadId'=$1 OR payload->'lead'->>'id'=$1
          OR payload->'context'->'lead'->>'id'=$1
        ORDER BY created_at LIMIT 80`, [id]),
    ]);
    const rows = drafts.rows;
    const initialDrafts = rows.filter((draft: any) => draft.metadata?.mode === 'response' || draft.kind === 'initial_response');
    const flDrafts = rows.filter((draft: any) => draft.metadata?.mode === 'chat' && draft.channel === 'fl');
    const telegramDrafts = rows.filter((draft: any) => draft.metadata?.mode === 'chat' && draft.channel === 'telegram');
    const steps = buildSandboxSteps({
      analysisState: String(lead.analysis_state || ''),
      score: lead.score ?? null,
      confidence: lead.confidence ?? null,
      initialDrafts,
      flDrafts,
      telegramDrafts,
      messages: messages.rows,
      handoffs: handoffs.rows,
      requirements: requirements.rows,
      documents: documents.rows,
      designCount: designs.rows.length,
      deliveries: deliveries.rows,
    });
    const escapedDeliveries = deliveries.rows.filter((delivery: any) => !(
      delivery.status === 'sent'
      && String(delivery.external_id || '').startsWith('sandbox:')
      && String(delivery.error || '').startsWith('[sandbox]')
    ));
    return {
      lead,
      messages: messages.rows,
      drafts: rows,
      requirements: requirements.rows,
      documents: documents.rows,
      designs: designs.rows.map((asset: any) => ({ ...asset, preview_url: `/sales/api/sandbox/assets/${asset.id}` })),
      handoffs: handoffs.rows,
      deliveries: deliveries.rows,
      activities: activities.rows,
      turns: turns.rows,
      channels: channels.rows,
      ai_tasks: tasks.rows,
      safety: {
        external_writes_blocked: escapedDeliveries.length === 0,
        captured_deliveries: deliveries.rows.length - escapedDeliveries.length,
        escaped_deliveries: escapedDeliveries.length,
      },
      steps,
    };
  }

  async draftInitial(id: string) {
    const lead = await this.sandboxLead(id);
    if (lead.analysis_state !== 'completed') throw new BadRequestException('Сначала дождитесь завершения оценки');
    await this.queue.add(
      'draft-reply',
      { leadId: id, channel: 'fl', targetExternalId: lead.external_id, mode: 'response', ownerRequested: true },
      `sandbox-response-${id}-${Date.now()}`,
    );
    return { queued: true };
  }

  async clientMessage(id: string, content: string) {
    const lead = await this.sandboxLead(id);
    const text = content.trim().slice(0, 8_000);
    if (!text) throw new BadRequestException('Введите сообщение тестового клиента');
    const dialogId = String(lead.client?.fl_dialog_id || `sandbox-dialog-${id}`);
    const externalId = `sandbox-message-${randomBytes(8).toString('hex')}`;
    const message = await this.db.transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO messages(lead_id,channel,external_id,direction,author,content,metadata)
         VALUES($1,'fl',$2,'inbound','Тестовый заказчик',$3,$4) RETURNING id`,
        [id, externalId, text, JSON.stringify({ sandbox: true })],
      );
      await client.query(
        `UPDATE leads SET client=client || $2::jsonb,last_inbound_message_id=$3,
         status='discovery',pipeline_stage='conversation',next_action='Подготовить ответ тестовому клиенту',updated_at=now()
         WHERE id=$1`,
        [id, JSON.stringify({ fl_dialog_id: dialogId }), inserted.rows[0].id],
      );
      await client.query(
        "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'sandbox','sandbox_client_message',$2)",
        [id, JSON.stringify({ messageId: inserted.rows[0].id })],
      );
      return inserted.rows[0];
    });
    await this.queue.add(
      'draft-reply',
      { leadId: id, channel: 'fl', targetExternalId: dialogId, mode: 'chat', ownerRequested: true },
      `sandbox-chat-${message.id}`,
    );
    return { queued: true, messageId: message.id };
  }

  async handoff(id: string) {
    await this.sandboxLead(id);
    const existing = await this.db.query<{ token: string }>(
      `SELECT token FROM conversation_handoffs WHERE lead_id=$1 AND status='pending' AND expires_at>now()
       ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    const token = existing.rows[0]?.token || `FS-${randomBytes(4).toString('hex').slice(0, 6).toUpperCase()}`;
    if (!existing.rows[0]) {
      await this.db.query(
        `INSERT INTO conversation_handoffs(lead_id,token,from_channel,to_channel,expires_at)
         VALUES($1,$2,'fl','telegram',now()+interval '1 day')`,
        [id, token],
      );
    }
    const chatId = `sandbox-telegram-${id}`;
    const resolved = await this.salesAgent.resolveTelegramLead(chatId, `Здравствуйте, код ${token}`);
    if (resolved !== id) throw new Error('Тестовый переход не связался с исходной сделкой');
    await this.db.query(
      "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'sandbox','sandbox_handoff_used',$2)",
      [id, JSON.stringify({ token })],
    );
    return { ok: true, token };
  }

  async telegramMessage(id: string, content: string) {
    await this.sandboxLead(id);
    const text = content.trim().slice(0, 8_000);
    if (!text) throw new BadRequestException('Введите сообщение тестового клиента в Telegram');
    const handoff = (await this.db.query<{ target_external_id: string }>(
      `SELECT target_external_id FROM conversation_handoffs
       WHERE lead_id=$1 AND status='used' AND to_channel='telegram'
       ORDER BY used_at DESC LIMIT 1`,
      [id],
    )).rows[0];
    if (!handoff?.target_external_id) throw new BadRequestException('Сначала выполните переход FL → Telegram');
    const messageId = `sandbox-${randomBytes(8).toString('hex')}`;
    await this.telegram.processUpdate({
      business_message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1_000),
        chat: { id: handoff.target_external_id, first_name: 'Тестовый заказчик', username: 'sandbox_customer' },
        from: { id: Number.MAX_SAFE_INTEGER - 17, first_name: 'Тестовый заказчик', username: 'sandbox_customer' },
        text,
      },
    });
    await this.queue.add(
      'draft-reply',
      { leadId: id, channel: 'telegram', targetExternalId: handoff.target_external_id, ownerRequested: true },
      `sandbox-telegram-chat-${messageId}`,
    );
    await this.db.query(
      "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'sandbox','sandbox_telegram_message',$2)",
      [id, JSON.stringify({ messageId, externalWriteBlocked: true })],
    );
    return { queued: true, messageId };
  }

  async documents(id: string) {
    await this.sandboxLead(id);
    await this.queue.add('generate-documents', { leadId: id }, `sandbox-documents-${id}-${Date.now()}`);
    return { queued: true };
  }

  async design(id: string) {
    await this.sandboxLead(id);
    await this.queue.add(
      'generate-design',
      { leadId: id, ownerExternalId: '', instructions: 'Создай аккуратную презентационную концепцию интерфейса по задаче клиента', count: 2, sandbox: true },
      `sandbox-design-${id}-${Date.now()}`,
    );
    return { queued: true };
  }

  async archive(id: string) {
    await this.sandboxLead(id);
    await this.db.query("UPDATE leads SET status='archived',updated_at=now() WHERE id=$1", [id]);
    return { ok: true };
  }

  async asset(id: string) {
    const asset = (await this.db.query<{ file_path: string; content_type: string }>(
      `SELECT a.file_path,a.content_type FROM design_assets a
       JOIN leads l ON l.id=a.lead_id
       WHERE a.id=$1 AND l.source='sandbox' AND l.client->>'sandbox'='true'`,
      [id],
    )).rows[0];
    if (!asset) throw new NotFoundException('Тестовая концепция не найдена');
    const root = resolve(process.env.DOCUMENTS_DIR || '/app/data/documents');
    const path = resolve(asset.file_path);
    if (!path.startsWith(`${root}${sep}`)) throw new NotFoundException('Тестовая концепция не найдена');
    return { path, contentType: asset.content_type || 'image/png' };
  }

  private async sandboxLead(id: string): Promise<any> {
    const lead = (await this.db.query('SELECT * FROM leads WHERE id=$1', [id])).rows[0];
    if (!lead || !isSandboxLead(lead)) throw new NotFoundException('Тестовый прогон не найден');
    return lead;
  }
}
