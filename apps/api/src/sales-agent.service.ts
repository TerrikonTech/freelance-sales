import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AiService } from './ai.service';
import { CodexTaskService } from './codex-task.service';
import { DatabaseService } from './database.service';
import { QueueService } from './queue.service';
import { SettingsService } from './settings.service';

const PIPELINE_STAGES = [
  'new',
  'qualified',
  'outreach',
  'conversation',
  'telegram_handoff',
  'discovery',
  'proposal',
  'contract',
  'build_ready',
  'won',
  'lost',
] as const;

type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type RequirementPatch = {
  category: string;
  slug: string;
  title: string;
  value: unknown;
  status: 'open' | 'confirmed' | 'assumed' | 'rejected' | 'not_applicable';
  required: boolean;
  confidence: number;
};

export type ConversationTurn = {
  intent: string;
  stage: PipelineStage;
  reply: string;
  summary: string;
  next_action: string;
  discovery_readiness: number;
  build_readiness: number;
  should_move_to_telegram: boolean;
  discovery_complete: boolean;
  requires_owner: boolean;
  risk_flags: string[];
  requirements: RequirementPatch[];
};

type LeadRow = {
  id: string;
  source: string;
  external_id: string | null;
  title: string;
  description: string;
  status: string;
  pipeline_stage: string;
  conversation_summary: string;
  discovery_readiness: number;
  build_readiness: number;
  next_action: string | null;
  analysis: Record<string, unknown>;
  requirements: Record<string, unknown>;
  client: Record<string, unknown>;
  recommended_price: number | null;
  recommended_days: number | null;
  last_inbound_message_id: string | null;
};

@Injectable()
export class SalesAgentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tasks: CodexTaskService,
    private readonly settings: SettingsService,
    private readonly ai: AiService,
    private readonly queue: QueueService,
  ) {}

  async prepareTurn(leadId: string, channel: string): Promise<ConversationTurn> {
    const lead = await this.lead(leadId);
    const [messages, requirements, handoff] = await Promise.all([
      this.messages(leadId, 240),
      this.requirements(leadId),
      this.ensureTelegramHandoff(leadId, channel),
    ]);
    await this.registerLeadChannel(leadId, channel, this.channelExternalId(lead, channel));

    const result = await this.tasks.run<ConversationTurn>(
      'conversation_turn',
      {
        lead: this.publicLeadContext(lead),
        messages,
        structured_requirements: requirements,
        telegram_handoff: handoff,
        policy: {
          goal: 'Продвинуть сделку к полностью согласованному ТЗ без давления и выдуманных обещаний',
          ask_one_topic_at_a_time: true,
          owner_review_for_commitments: true,
        },
      },
      4 * 60_000,
    );
    const turn = this.normalizeTurn(result, lead.pipeline_stage);
    if (turn.should_move_to_telegram && channel === 'fl' && handoff?.username) {
      const invitation = `Напишите мне в Telegram @${handoff.username} и укажите код ${handoff.token}, чтобы я сразу продолжил этот диалог.`;
      if (!turn.reply.includes(handoff.token)) turn.reply = `${turn.reply.trim()}\n\n${invitation}`;
      turn.stage = 'telegram_handoff';
    }
    await this.persistTurn(lead, channel, turn);
    return turn;
  }

  async answerOwner(leadId: string, question: string) {
    const lead = await this.lead(leadId);
    const [messages, requirements] = await Promise.all([
      this.messages(leadId, 300),
      this.requirements(leadId),
    ]);
    return this.tasks.run<{ answer: string; evidence_message_ids: string[] }>(
      'owner_query',
      {
        question: question.trim().slice(0, 4_000),
        lead: this.publicLeadContext(lead),
        messages,
        structured_requirements: requirements,
      },
      3 * 60_000,
    );
  }

  async resolveTelegramLead(chatId: string, text: string): Promise<string | null> {
    const linked = await this.db.query<{ lead_id: string }>(
      "SELECT lead_id FROM lead_channels WHERE channel='telegram' AND external_id=$1",
      [chatId],
    );
    if (linked.rows[0]) return linked.rows[0].lead_id;

    const token = text.toUpperCase().match(/\bFS-[A-Z0-9]{6}\b/)?.[0];
    if (!token) return null;
    return this.db.transaction(async (client) => {
      const handoff = await client.query<{ id: string; lead_id: string }>(
        `SELECT id,lead_id FROM conversation_handoffs
         WHERE token=$1 AND status='pending' AND expires_at>now()
         FOR UPDATE`,
        [token],
      );
      if (!handoff.rows[0]) return null;
      await client.query(
        `INSERT INTO lead_channels(lead_id,channel,external_id,metadata)
         VALUES($1,'telegram',$2,$3)
         ON CONFLICT(channel,external_id) DO UPDATE SET
           lead_id=EXCLUDED.lead_id,metadata=EXCLUDED.metadata,last_seen_at=now()`,
        [handoff.rows[0].lead_id, chatId, JSON.stringify({ handoffToken: token })],
      );
      await client.query(
        "UPDATE conversation_handoffs SET status='used',target_external_id=$2,used_at=now() WHERE id=$1",
        [handoff.rows[0].id, chatId],
      );
      await client.query(
        "UPDATE leads SET pipeline_stage='discovery',next_action='Продолжить интервью в Telegram',updated_at=now() WHERE id=$1",
        [handoff.rows[0].lead_id],
      );
      return handoff.rows[0].lead_id;
    });
  }

  async registerLeadChannel(leadId: string, channel: string, externalId: string | null) {
    if (!externalId) return;
    await this.db.query(
      `INSERT INTO lead_channels(lead_id,channel,external_id)
       VALUES($1,$2,$3)
       ON CONFLICT(channel,external_id) DO UPDATE SET
         lead_id=EXCLUDED.lead_id,last_seen_at=now()`,
      [leadId, channel, externalId],
    );
  }

  async state(leadId: string) {
    const [lead, requirements, channels, handoffs, codex] = await Promise.all([
      this.lead(leadId),
      this.requirements(leadId),
      this.db.query(
        'SELECT channel,external_id,metadata,last_seen_at FROM lead_channels WHERE lead_id=$1 ORDER BY linked_at',
        [leadId],
      ),
      this.db.query(
        'SELECT token,from_channel,to_channel,status,expires_at,used_at FROM conversation_handoffs WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 5',
        [leadId],
      ),
      this.db.query(
        'SELECT id,version,status,created_at,updated_at FROM codex_handoffs WHERE lead_id=$1 ORDER BY version DESC LIMIT 1',
        [leadId],
      ),
    ]);
    return {
      stage: lead.pipeline_stage,
      summary: lead.conversation_summary,
      discoveryReadiness: lead.discovery_readiness,
      buildReadiness: lead.build_readiness,
      nextAction: lead.next_action,
      requirements,
      channels: channels.rows,
      handoffs: handoffs.rows,
      codexHandoff: codex.rows[0] || null,
    };
  }

  async buildCodexHandoff(leadId: string) {
    const lead = await this.lead(leadId);
    const [messages, requirements] = await Promise.all([
      this.messages(leadId, 400),
      this.requirements(leadId),
    ]);
    const payload = await this.tasks.run<Record<string, unknown>>(
      'implementation_handoff',
      {
        lead: this.publicLeadContext(lead),
        messages,
        structured_requirements: requirements,
      },
      8 * 60_000,
    );
    const openQuestions = Array.isArray(payload.open_questions) ? payload.open_questions : [];
    const versionResult = await this.db.query<{ version: number }>(
      'SELECT COALESCE(max(version),0)+1 AS version FROM codex_handoffs WHERE lead_id=$1',
      [leadId],
    );
    const version = Number(versionResult.rows[0].version);
    const status = openQuestions.length === 0 ? 'ready' : 'needs_answers';
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO codex_handoffs(
         lead_id,version,status,payload,source_last_message_id
       ) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [leadId, version, status, JSON.stringify(payload), lead.last_inbound_message_id],
    );
    await this.db.query(
      `UPDATE leads SET build_readiness=$2,
       pipeline_stage=CASE WHEN $2=100 THEN 'build_ready' ELSE pipeline_stage END,
       next_action=CASE WHEN $2=100 THEN 'Проверить и одобрить пакет для Codex'
         ELSE 'Закрыть открытые вопросы перед разработкой' END,
       updated_at=now() WHERE id=$1`,
      [leadId, openQuestions.length === 0 ? 100 : Math.min(95, lead.build_readiness)],
    );
    return { id: inserted.rows[0].id, version, status, payload };
  }

  async recentLeads(limit = 10) {
    return (
      await this.db.query(
        `SELECT l.id,l.title,l.pipeline_stage,l.updated_at,
          COALESCE(
            (SELECT channel FROM lead_channels c WHERE c.lead_id=l.id
             ORDER BY CASE c.channel WHEN 'telegram' THEN 0 WHEN 'fl' THEN 1 ELSE 2 END,
               c.last_seen_at DESC LIMIT 1),
            l.source
          ) AS channel
         FROM leads l
         WHERE l.status<>'archived'
           AND (EXISTS (SELECT 1 FROM messages m WHERE m.lead_id=l.id)
             OR l.status IN ('qualified','contacted','discovery','proposal','negotiation'))
         ORDER BY COALESCE(
           (SELECT max(created_at) FROM messages m WHERE m.lead_id=l.id),
           l.updated_at
         ) DESC LIMIT $1`,
        [Math.max(1, Math.min(30, limit))],
      )
    ).rows;
  }

  async selectOwnerLead(ownerExternalId: string, query: string) {
    const normalized = query.trim().slice(0, 200);
    if (!normalized) return { selected: null, matches: await this.recentLeads(10) };
    const result = await this.db.query(
      `SELECT DISTINCT l.id,l.title,l.pipeline_stage,l.updated_at
       FROM leads l
       LEFT JOIN lead_channels c ON c.lead_id=l.id
       WHERE l.status<>'archived' AND (
         l.title ILIKE $1 OR l.external_id ILIKE $1 OR c.external_id ILIKE $1
         OR l.client::text ILIKE $1
       )
       ORDER BY l.updated_at DESC LIMIT 8`,
      [`%${normalized.replace(/[%_]/g, '\\$&')}%`],
    );
    if (result.rows.length !== 1) return { selected: null, matches: result.rows };
    const selected = result.rows[0];
    await this.db.query(
      `INSERT INTO owner_agent_sessions(owner_external_id,active_lead_id,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(owner_external_id) DO UPDATE SET
         active_lead_id=EXCLUDED.active_lead_id,pending_draft_id=NULL,updated_at=now()`,
      [ownerExternalId, selected.id],
    );
    return { selected, matches: result.rows };
  }

  async ownerLead(ownerExternalId: string) {
    return (
      await this.db.query(
        `SELECT l.* FROM owner_agent_sessions s
         JOIN leads l ON l.id=s.active_lead_id
         WHERE s.owner_external_id=$1`,
        [ownerExternalId],
      )
    ).rows[0] || null;
  }

  async prepareOwnerOutbound(ownerExternalId: string, instructions: string) {
    const lead = await this.ownerLead(ownerExternalId) as LeadRow | null;
    if (!lead) throw new Error('Сначала выберите клиента');
    const messages = await this.messages(lead.id, 300);
    const content = await this.ai.draftReply({
      lead,
      messages,
      mode: 'chat',
      ownerInstructions: instructions.trim().slice(0, 4_000),
    });
    const target = await this.preferredOutboundTarget(lead);
    if (!target) throw new Error('У клиента ещё нет доступного канала для ответа');
    const hash = createHash('sha256').update(content).digest('hex');
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO drafts(
         lead_id,kind,channel,target_external_id,content,content_hash,
         source_last_message_id,metadata
       ) VALUES($1,'reply',$2,$3,$4,$5,$6,$7)
       ON CONFLICT(channel,target_external_id,content_hash) DO UPDATE SET
         status='pending',source_last_message_id=EXCLUDED.source_last_message_id,
         metadata=EXCLUDED.metadata,updated_at=now()
       RETURNING id`,
      [
        lead.id,
        target.channel,
        target.externalId,
        content,
        hash,
        lead.last_inbound_message_id,
        JSON.stringify({
          mode: 'chat',
          preparedBy: 'telegram_owner',
          ownerInstructions: instructions.slice(0, 4_000),
        }),
      ],
    );
    await this.db.query(
      `INSERT INTO owner_agent_sessions(owner_external_id,active_lead_id,pending_draft_id,updated_at)
       VALUES($1,$2,$3,now())
       ON CONFLICT(owner_external_id) DO UPDATE SET
         active_lead_id=EXCLUDED.active_lead_id,pending_draft_id=EXCLUDED.pending_draft_id,
         updated_at=now()`,
      [ownerExternalId, lead.id, inserted.rows[0].id],
    );
    return {
      draftId: inserted.rows[0].id,
      content,
      leadTitle: lead.title,
      channel: target.channel,
    };
  }

  async approveOwnerOutbound(ownerExternalId: string) {
    const approved = await this.db.transaction(async (client) => {
      const selected = await client.query(
        `SELECT d.id,d.lead_id,d.status,d.source_last_message_id,l.last_inbound_message_id
         FROM owner_agent_sessions s
         JOIN drafts d ON d.id=s.pending_draft_id
         JOIN leads l ON l.id=d.lead_id
         WHERE s.owner_external_id=$1 FOR UPDATE OF d,s`,
        [ownerExternalId],
      );
      const row = selected.rows[0];
      if (!row) throw new Error('Нет подготовленного ответа. Сначала попросите его написать');
      if ((row.source_last_message_id || null) !== (row.last_inbound_message_id || null)) {
        await client.query("UPDATE drafts SET status='stale',updated_at=now() WHERE id=$1", [row.id]);
        await client.query(
          'UPDATE owner_agent_sessions SET pending_draft_id=NULL,updated_at=now() WHERE owner_external_id=$1',
          [ownerExternalId],
        );
        throw new Error('Клиент уже прислал новое сообщение — старый ответ не отправлен');
      }
      if (row.status !== 'pending') throw new Error('Этот ответ уже обработан');
      await client.query(
        `UPDATE drafts SET status='approved',approved_at=now(),
         metadata=metadata || jsonb_build_object('approved_via','telegram_natural_command'),
         updated_at=now() WHERE id=$1`,
        [row.id],
      );
      await client.query(
        'UPDATE owner_agent_sessions SET pending_draft_id=NULL,updated_at=now() WHERE owner_external_id=$1',
        [ownerExternalId],
      );
      await client.query(
        "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'telegram-owner','draft_approved',$2)",
        [row.lead_id, JSON.stringify({ draftId: row.id, naturalCommand: true })],
      );
      return { draftId: row.id };
    });
    await this.queue.add(
      'send-draft',
      { draftId: approved.draftId },
      `telegram-owner-send-${approved.draftId}`,
    );
    return approved;
  }

  private async persistTurn(lead: LeadRow, channel: string, turn: ConversationTurn) {
    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE leads SET pipeline_stage=$2,conversation_summary=$3,
         discovery_readiness=$4,build_readiness=$5,next_action=$6,updated_at=now()
         WHERE id=$1`,
        [
          lead.id,
          turn.stage,
          turn.summary,
          turn.discovery_readiness,
          turn.build_readiness,
          turn.next_action,
        ],
      );
      for (const item of turn.requirements) {
        await client.query(
          `INSERT INTO sales_requirements(
             lead_id,category,slug,title,value,status,required,
             source_message_id,confidence
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT(lead_id,category,slug) DO UPDATE SET
             title=EXCLUDED.title,value=EXCLUDED.value,status=EXCLUDED.status,
             required=EXCLUDED.required,source_message_id=EXCLUDED.source_message_id,
             confidence=EXCLUDED.confidence,updated_at=now()`,
          [
            lead.id,
            item.category,
            item.slug,
            item.title,
            JSON.stringify(item.value),
            item.status,
            item.required,
            lead.last_inbound_message_id,
            item.confidence,
          ],
        );
      }
      await client.query(
        `INSERT INTO agent_turns(
           lead_id,source_message_id,channel,stage_before,stage_after,
           intent,reply,summary,decision
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          lead.id,
          lead.last_inbound_message_id,
          channel,
          this.stage(lead.pipeline_stage),
          turn.stage,
          turn.intent,
          turn.reply,
          turn.summary,
          JSON.stringify({
            nextAction: turn.next_action,
            requiresOwner: turn.requires_owner,
            riskFlags: turn.risk_flags,
            discoveryComplete: turn.discovery_complete,
          }),
        ],
      );
    });
  }

  private async ensureTelegramHandoff(leadId: string, fromChannel: string) {
    const seller = await this.settings.getPublic<Record<string, unknown>>('seller_profile');
    const username = String(seller?.telegram_username || '').trim().replace(/^@/, '');
    if (!username || fromChannel !== 'fl') return null;
    const existing = await this.db.query<{ token: string; expires_at: string }>(
      `SELECT token,expires_at FROM conversation_handoffs
       WHERE lead_id=$1 AND from_channel=$2 AND to_channel='telegram'
         AND status='pending' AND expires_at>now()
       ORDER BY created_at DESC LIMIT 1`,
      [leadId, fromChannel],
    );
    if (existing.rows[0]) return { ...existing.rows[0], username };
    const token = `FS-${randomBytes(4).toString('hex').slice(0, 6).toUpperCase()}`;
    const created = await this.db.query<{ token: string; expires_at: string }>(
      `INSERT INTO conversation_handoffs(
         lead_id,token,from_channel,to_channel,expires_at
       ) VALUES($1,$2,$3,'telegram',now()+interval '30 days')
       RETURNING token,expires_at`,
      [leadId, token, fromChannel],
    );
    return { ...created.rows[0], username };
  }

  private async lead(leadId: string): Promise<LeadRow> {
    const result = await this.db.query<LeadRow>('SELECT * FROM leads WHERE id=$1', [leadId]);
    if (!result.rows[0]) throw new Error('Клиент или сделка не найдены');
    return result.rows[0];
  }

  private async messages(leadId: string, limit: number) {
    return (
      await this.db.query(
        `SELECT * FROM (
           SELECT id,channel,direction,author,content,metadata,created_at
           FROM messages WHERE lead_id=$1 ORDER BY created_at DESC LIMIT $2
         ) recent ORDER BY created_at`,
        [leadId, limit],
      )
    ).rows;
  }

  private async requirements(leadId: string) {
    return (
      await this.db.query(
        `SELECT category,slug,title,value,status,required,confidence,updated_at
         FROM sales_requirements WHERE lead_id=$1
         ORDER BY required DESC,category,title`,
        [leadId],
      )
    ).rows;
  }

  private channelExternalId(lead: LeadRow, channel: string) {
    if (channel === lead.source) return lead.external_id;
    if (channel === 'fl') return String(lead.client?.fl_dialog_id || '') || null;
    if (channel === 'telegram') return String(lead.client?.telegram_chat_id || '') || null;
    return null;
  }

  private async preferredOutboundTarget(lead: LeadRow) {
    const linked = await this.db.query<{ channel: string; external_id: string }>(
      `SELECT channel,external_id FROM lead_channels
       WHERE lead_id=$1 AND channel IN ('telegram','fl')
       ORDER BY CASE channel WHEN 'telegram' THEN 0 ELSE 1 END,last_seen_at DESC LIMIT 1`,
      [lead.id],
    );
    if (linked.rows[0]) {
      return {
        channel: linked.rows[0].channel,
        externalId: linked.rows[0].external_id,
      };
    }
    const fallback = this.channelExternalId(lead, lead.source);
    return fallback ? { channel: lead.source, externalId: fallback } : null;
  }

  private publicLeadContext(lead: LeadRow) {
    return {
      id: lead.id,
      source: lead.source,
      title: lead.title,
      description: lead.description,
      status: lead.status,
      pipeline_stage: this.stage(lead.pipeline_stage),
      conversation_summary: lead.conversation_summary,
      discovery_readiness: lead.discovery_readiness,
      build_readiness: lead.build_readiness,
      next_action: lead.next_action,
      analysis: lead.analysis,
      requirements: lead.requirements,
      client: lead.client,
      recommended_price: lead.recommended_price,
      recommended_days: lead.recommended_days,
    };
  }

  private normalizeTurn(value: ConversationTurn, fallbackStage: string): ConversationTurn {
    const stage = this.stage(value?.stage || fallbackStage);
    const requirements = Array.isArray(value?.requirements)
      ? value.requirements.slice(0, 40).map((item) => ({
          category: String(item.category || 'general').slice(0, 80),
          slug: String(item.slug || 'unknown').slice(0, 100),
          title: String(item.title || item.slug || 'Требование').slice(0, 240),
          value: item.value ?? null,
          status: ['open', 'confirmed', 'assumed', 'rejected', 'not_applicable'].includes(item.status)
            ? item.status
            : 'open',
          required: item.required !== false,
          confidence: this.percent(item.confidence),
        }))
      : [];
    const reply = String(value?.reply || '').trim();
    if (!reply) throw new Error('Агент вернул пустой ответ');
    return {
      intent: String(value?.intent || 'unknown').slice(0, 100),
      stage,
      reply: reply.slice(0, 4_000),
      summary: String(value?.summary || '').slice(0, 8_000),
      next_action: String(value?.next_action || '').slice(0, 500),
      discovery_readiness: this.percent(value?.discovery_readiness),
      build_readiness: this.percent(value?.build_readiness),
      should_move_to_telegram: value?.should_move_to_telegram === true,
      discovery_complete: value?.discovery_complete === true,
      requires_owner: value?.requires_owner === true,
      risk_flags: Array.isArray(value?.risk_flags)
        ? value.risk_flags.map(String).slice(0, 12)
        : [],
      requirements,
    };
  }

  private stage(value: string): PipelineStage {
    return PIPELINE_STAGES.includes(value as PipelineStage)
      ? (value as PipelineStage)
      : 'conversation';
  }

  private percent(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
  }
}
