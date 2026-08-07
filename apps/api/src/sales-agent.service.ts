import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AiService } from './ai.service';
import { AutonomyService } from './autonomy.service';
import { CodexTaskService } from './codex-task.service';
import { DatabaseService } from './database.service';
import type { DesignConceptResult } from './design-concept.service';
import { QueueService } from './queue.service';
import { SettingsService } from './settings.service';
import { outboundCommitmentIssues, spotlightClientData } from './research-controls';
import {
  buildChatPolicySnapshot,
  CHAT_STAGES,
  ChatPolicySnapshot,
  ChatStage,
  ChatStopReason,
  ownerEscalationReply,
  ownerReplyDeadline,
  reviewChatReply,
} from './chat-policy';

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
  conversation_stage: ChatStage;
  confidence: number;
  reply: string;
  summary: string;
  next_action: string;
  discovery_readiness: number;
  build_readiness: number;
  should_move_to_telegram: boolean;
  discovery_complete: boolean;
  requires_owner: boolean;
  value_before_question: boolean;
  owner_brief: string | null;
  reply_deadline: string | null;
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

function identityTokens(value: unknown): string[] {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function clientIdentityValues(client: Record<string, unknown>): string[] {
  return Object.entries(client)
    .filter(([key, value]) => (
      /(?:^|_)(?:name|username|login|nickname|handle)$/iu.test(key)
      && (typeof value === 'string' || typeof value === 'number')
    ))
    .map(([, value]) => String(value));
}

type RecipientCandidate = Pick<LeadRow, 'id' | 'title' | 'client'> & {
  recipient_aliases?: string[];
};

function recipientNameForms(value: string): Set<string> {
  const token = identityTokens(value)[0] || '';
  const forms = new Set<string>(token ? [token] : []);
  if (token.length >= 5 && /[аеуюя]$/u.test(token)) forms.add(token.slice(0, -1));
  if (token.endsWith('ею')) forms.add(`${token.slice(0, -2)}ей`);
  if (token.endsWith('ию')) forms.add(`${token.slice(0, -2)}ий`);
  if (token.endsWith('ии')) forms.add(`${token.slice(0, -2)}ия`);
  if (token.endsWith('ю')) forms.add(`${token.slice(0, -1)}ь`);
  if (token.length >= 5 && /(?:ом|ем)$/u.test(token)) forms.add(token.slice(0, -2));
  if (token.endsWith('еем')) forms.add(`${token.slice(0, -3)}ей`);
  if (token.endsWith('ием')) forms.add(`${token.slice(0, -3)}ий`);
  return forms;
}

export function recipientMatchesLead(
  recipient: string,
  lead: Pick<LeadRow, 'title' | 'client'>,
  aliases: string[] = [],
): boolean {
  const leadForms = new Set(
    identityTokens([...clientIdentityValues(lead.client || {}), ...aliases].join(' '))
      .flatMap((token) => Array.from(recipientNameForms(token))),
  );
  return Array.from(recipientNameForms(recipient)).some((form) => form.length >= 3 && leadForms.has(form));
}

export function matchingRecipientLeads(
  recipient: string,
  candidates: RecipientCandidate[],
): RecipientCandidate[] {
  return candidates.filter((candidate) => recipientMatchesLead(
    recipient,
    candidate,
    Array.isArray(candidate.recipient_aliases) ? candidate.recipient_aliases : [],
  ));
}

@Injectable()
export class SalesAgentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tasks: CodexTaskService,
    private readonly settings: SettingsService,
    private readonly ai: AiService,
    private readonly queue: QueueService,
    private readonly autonomy: AutonomyService,
  ) {}

  async prepareTurn(leadId: string, channel: string): Promise<ConversationTurn> {
    const lead = await this.lead(leadId);
    const [messages, requirements, handoff, priorTurns, episodes] = await Promise.all([
      this.messages(leadId, 240),
      this.requirements(leadId),
      this.ensureTelegramHandoff(leadId, channel),
      this.db.query<{ reply: string; decision: Record<string, unknown> }>(
        `SELECT reply,decision FROM agent_turns
         WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 12`,
        [leadId],
      ),
      this.db.query(
        `SELECT event_type,summary,outcome,importance,created_at FROM lead_episodes
         WHERE lead_id=$1 ORDER BY importance DESC,created_at DESC LIMIT 8`,
        [leadId],
      ),
    ]);
    await this.registerLeadChannel(leadId, channel, this.channelExternalId(lead, channel));

    const chatPolicy = buildChatPolicySnapshot({
      channel,
      pipelineStage: lead.pipeline_stage,
      messages,
      priorAgentReplies: priorTurns.rows.map((item) => item.reply),
      previousConversationStage: String(priorTurns.rows[0]?.decision?.conversationStage || '') || null,
    });
    if (chatPolicy.stopReasons.includes('negative_tone')) {
      await this.recordLatestNegativeReaction(leadId);
    }

    const taskPayload = {
      lead: this.publicLeadContext(lead),
      messages,
      inbound_bundle: chatPolicy.inboundBundle,
      spotlighted_client_data: spotlightClientData(
        { messages, inbound_bundle: chatPolicy.inboundBundle },
        `${lead.id}:${lead.last_inbound_message_id || 'none'}`,
      ),
      structured_requirements: requirements,
      relevant_episodes: episodes.rows,
      telegram_handoff: handoff,
      policy: {
        goal: 'Продвинуть сделку к полностью согласованному ТЗ без давления и выдуманных обещаний',
        ask_one_topic_at_a_time: true,
        owner_review_for_commitments: true,
        current_conversation_stage: chatPolicy.conversationStage,
        discovery_questions_used: chatPolicy.discoveryQuestionsUsed,
        discovery_questions_remaining: chatPolicy.discoveryQuestionsRemaining,
        response_profile: chatPolicy.responseProfile,
        deterministic_stop_reasons: chatPolicy.stopReasons,
      },
    };
    let result = await this.tasks.run<ConversationTurn>('conversation_turn', taskPayload, 4 * 60_000);
    let turn: ConversationTurn;
    try {
      turn = this.normalizeTurn(result, lead.pipeline_stage, chatPolicy, lead.id, priorTurns.rows.map((item) => item.reply));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!message.startsWith('Ответ чат-агента не прошёл контроль:')) throw error;
      result = await this.tasks.run<ConversationTurn>(
        'conversation_turn',
        {
          ...taskPayload,
          revision: {
            previous_reply: result.reply,
            issues: message.replace(/^Ответ чат-агента не прошёл контроль:\s*/u, ''),
          },
        },
        4 * 60_000,
      );
      turn = this.normalizeTurn(result, lead.pipeline_stage, chatPolicy, lead.id, priorTurns.rows.map((item) => item.reply));
    }
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
    const [messages, requirements, dealState, documents, activities, seller, pricingPolicy] = await Promise.all([
      this.messages(leadId, 500),
      this.requirements(leadId),
      this.state(leadId),
      this.db.query(
        `SELECT kind,version,metadata,created_at FROM documents
         WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 30`,
        [leadId],
      ),
      this.db.query(
        `SELECT actor,action,details,created_at FROM activities
         WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 100`,
        [leadId],
      ),
      this.settings.getPublic<Record<string, unknown>>('seller_profile'),
      this.settings.getPublic<Record<string, unknown>>('pricing_policy'),
    ]);
    return this.tasks.run<{ answer: string; evidence_message_ids: string[] }>(
      'owner_query',
      {
        question: question.trim().slice(0, 4_000),
        lead: this.publicLeadContext(lead),
        messages,
        structured_requirements: requirements,
        deal_state: dealState,
        documents: documents.rows,
        activities: activities.rows,
        seller_profile: seller || {},
        pricing_policy: pricingPolicy || {},
      },
      4 * 60_000,
    );
  }

  async answerOwnerOverview(question: string) {
    const [leads, seller, pricingPolicy] = await Promise.all([
      this.db.query(
        `SELECT l.id,l.title,l.source,l.status,l.pipeline_stage,l.score,l.confidence,
                l.recommended_price,l.recommended_days,l.conversation_summary,l.next_action,
                l.discovery_readiness,l.build_readiness,l.updated_at,
                (SELECT json_build_object(
                   'direction',m.direction,'content',left(m.content,1200),'created_at',m.created_at
                 ) FROM messages m WHERE m.lead_id=l.id ORDER BY m.created_at DESC LIMIT 1) AS latest_message
         FROM leads l
         WHERE l.status<>'archived' AND l.source<>'sandbox'
         ORDER BY COALESCE(
           (SELECT max(m.created_at) FROM messages m WHERE m.lead_id=l.id),
           l.updated_at
         ) DESC LIMIT 30`,
      ),
      this.settings.getPublic<Record<string, unknown>>('seller_profile'),
      this.settings.getPublic<Record<string, unknown>>('pricing_policy'),
    ]);
    return this.tasks.run<{ answer: string; evidence_lead_ids: string[] }>(
      'owner_overview',
      {
        question: question.trim().slice(0, 4_000),
        active_leads: leads.rows,
        seller_profile: seller || {},
        pricing_policy: pricingPolicy || {},
        policy: {
          on_demand_only: true,
          never_send_without_separate_owner_command: true,
        },
      },
      4 * 60_000,
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
         WHERE l.status<>'archived' AND l.source<>'sandbox'
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
       WHERE l.status<>'archived' AND l.source<>'sandbox' AND (
         l.title ILIKE $1 OR l.external_id ILIKE $1 OR c.external_id ILIKE $1
         OR l.client::text ILIKE $1
       )
       ORDER BY l.updated_at DESC LIMIT 8`,
      [`%${normalized.replace(/[%_]/g, '\\$&')}%`],
    );
    // "Олег" must not match "Анастасия Олеговна": prefer whole-word hits before giving up.
    let rows = result.rows;
    if (rows.length > 1) {
      const word = new RegExp(`(?:^|[^\\p{L}])${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu');
      const exact = rows.filter((row: any) => word.test(String(row.title || '')));
      if (exact.length) rows = exact;
    }
    if (rows.length !== 1) return { selected: null, matches: rows };
    const selected = rows[0];
    await this.db.query(
      `INSERT INTO owner_agent_sessions(owner_external_id,active_lead_id,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(owner_external_id) DO UPDATE SET
         active_lead_id=EXCLUDED.active_lead_id,pending_draft_id=NULL,updated_at=now()`,
      [ownerExternalId, selected.id],
    );
    return { selected, matches: rows };
  }

  /** Tries "Oleg Zotov" before "Oleg": the first variant that matches exactly one lead wins. */
  async selectOwnerLeadByCandidates(
    ownerExternalId: string,
    candidates: Array<{ recipient: string; instruction: string }>,
  ) {
    let last: Awaited<ReturnType<SalesAgentService['selectOwnerLead']>> | null = null;
    for (const candidate of candidates) {
      const found = await this.selectOwnerLead(ownerExternalId, candidate.recipient);
      if (found.selected) return { ...found, used: candidate };
      if (!last || found.matches.length) last = found;
    }
    return { ...(last || { selected: null, matches: [] }), used: candidates[candidates.length - 1] };
  }

  /** Remembers the half-understood command while the owner answers the agent's question. */
  async setPendingIntent(ownerExternalId: string, payload: unknown) {
    await this.db.query(
      `INSERT INTO owner_agent_sessions(owner_external_id,pending_intent,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(owner_external_id) DO UPDATE SET pending_intent=EXCLUDED.pending_intent,updated_at=now()`,
      [ownerExternalId, payload === null ? null : JSON.stringify(payload)],
    );
  }

  async takePendingIntent<T = any>(ownerExternalId: string): Promise<T | null> {
    const result = await this.db.query<{ pending_intent: T | null }>(
      'SELECT pending_intent FROM owner_agent_sessions WHERE owner_external_id=$1',
      [ownerExternalId],
    );
    const payload = result.rows[0]?.pending_intent || null;
    if (payload) {
      await this.db.query(
        'UPDATE owner_agent_sessions SET pending_intent=NULL,updated_at=now() WHERE owner_external_id=$1',
        [ownerExternalId],
      );
    }
    return payload;
  }

  async setPendingChoice(ownerExternalId: string, payload: unknown) {
    await this.db.query(
      `INSERT INTO owner_agent_sessions(owner_external_id,pending_choice,updated_at)
       VALUES($1,$2::jsonb,now())
       ON CONFLICT(owner_external_id) DO UPDATE SET pending_choice=EXCLUDED.pending_choice,updated_at=now()`,
      [ownerExternalId, JSON.stringify(payload)],
    );
  }

  async takePendingChoice<T = any>(ownerExternalId: string): Promise<T | null> {
    const result = await this.db.query<{ pending_choice: T | null }>(
      'SELECT pending_choice FROM owner_agent_sessions WHERE owner_external_id=$1',
      [ownerExternalId],
    );
    const payload = result.rows[0]?.pending_choice || null;
    if (payload) {
      await this.db.query(
        'UPDATE owner_agent_sessions SET pending_choice=NULL,updated_at=now() WHERE owner_external_id=$1',
        [ownerExternalId],
      );
    }
    return payload;
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

  async prepareOwnerOutbound(
    ownerExternalId: string,
    instructions: string,
    expectedRecipient: string | null = null,
  ) {
    const activeLead = await this.ownerLead(ownerExternalId) as LeadRow | null;
    const lead = expectedRecipient
      ? await this.resolveOwnerRecipient(ownerExternalId, expectedRecipient, activeLead)
      : activeLead;
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

  private async resolveOwnerRecipient(
    ownerExternalId: string,
    recipient: string,
    activeLead: LeadRow | null,
  ): Promise<LeadRow> {
    if (activeLead) {
      const aliases = (await this.db.query<{ author: string }>(
        `SELECT DISTINCT author FROM messages
         WHERE lead_id=$1 AND author IS NOT NULL AND author<>''
         ORDER BY author LIMIT 30`,
        [activeLead.id],
      )).rows.map((row) => row.author);
      if (recipientMatchesLead(recipient, activeLead, aliases)) return activeLead;
    }

    const candidates = await this.db.query<LeadRow & { recipient_aliases: string[] }>(
      `SELECT l.*,
              COALESCE(
                array_agg(DISTINCT m.author) FILTER (
                  WHERE m.author IS NOT NULL AND m.author<>'' AND m.author NOT IN ('owner','client')
                ),
                ARRAY[]::text[]
              ) AS recipient_aliases
       FROM leads l
       LEFT JOIN messages m ON m.lead_id=l.id
       WHERE l.source<>'sandbox'
       GROUP BY l.id
       ORDER BY l.updated_at DESC
       LIMIT 200`,
    );
    const matches = matchingRecipientLeads(recipient, candidates.rows);
    if (matches.length === 0) {
      throw new Error(
        `Не нашёл клиента «${recipient}» по имени или логину. `
        + 'Ничего не отправлено; уточните клиента или скажите «отправь клиенту …».',
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Нашёл несколько клиентов «${recipient}». `
        + 'Ничего не отправлено; сначала выберите нужный диалог.',
      );
    }
    const selected = matches[0] as LeadRow;
    await this.db.query(
      `INSERT INTO owner_agent_sessions(owner_external_id,active_lead_id,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(owner_external_id) DO UPDATE SET
         active_lead_id=EXCLUDED.active_lead_id,pending_draft_id=NULL,updated_at=now()`,
      [ownerExternalId, selected.id],
    );
    return selected;
  }

  async prepareDiscoveryOutbound(ownerExternalId: string) {
    const lead = await this.ownerLead(ownerExternalId) as LeadRow | null;
    if (!lead) throw new Error('Сначала выберите клиента');
    const target = await this.preferredOutboundTarget(lead);
    if (!target) throw new Error('У клиента ещё нет доступного канала для интервью');
    const turn = await this.prepareTurn(lead.id, target.channel);
    if (turn.discovery_complete) {
      await this.queue.add(
        'generate-documents',
        { leadId: lead.id },
        `owner-discovery-documents-${lead.id}-${String(lead.last_inbound_message_id || 'none')}`,
      );
      return {
        complete: true,
        leadTitle: lead.title,
        discoveryReadiness: turn.discovery_readiness,
        nextAction: turn.next_action,
      };
    }
    const content = String(turn.reply || '').trim();
    if (!content) throw new Error('Агент не сформировал следующий вопрос');
    const hash = createHash('sha256').update(content).digest('hex');
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO drafts(
         lead_id,kind,channel,target_external_id,content,content_hash,
         source_last_message_id,metadata
       ) VALUES($1,'discovery_question',$2,$3,$4,$5,$6,$7)
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
          mode: 'discovery',
          preparedBy: 'telegram_owner',
          discoveryReadiness: turn.discovery_readiness,
          buildReadiness: turn.build_readiness,
          nextAction: turn.next_action,
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
      complete: false,
      draftId: inserted.rows[0].id,
      content,
      leadTitle: lead.title,
      channel: target.channel,
      discoveryReadiness: turn.discovery_readiness,
      nextAction: turn.next_action,
    };
  }

  async queueOwnerDesign(
    ownerExternalId: string,
    request: { instructions: string; referenceUrl: string | null; count: number },
  ) {
    const configured = Boolean(
      await this.settings.getSecret('openai_image_api_key') || process.env.OPENAI_IMAGE_API_KEY,
    );
    if (!configured) {
      throw new Error('Генерация картинок не подключена. Добавьте OpenAI Images API key в настройках дашборда.');
    }
    const lead = await this.ownerLead(ownerExternalId) as LeadRow | null;
    if (!lead) throw new Error('Сначала выберите клиента');
    const count = Math.max(1, Math.min(4, Math.round(request.count || 4)));
    const job = await this.queue.add(
      'generate-design',
      {
        leadId: lead.id,
        ownerExternalId,
        instructions: request.instructions.slice(0, 4_000),
        referenceUrl: request.referenceUrl,
        count,
      },
      `owner-design-${lead.id}-${Date.now()}`,
    );
    return { jobId: job.id, leadTitle: lead.title, count, estimatedCostUsd: count * 0.005 };
  }

  async prepareDesignOutbound(
    ownerExternalId: string,
    leadId: string,
    result: DesignConceptResult,
  ) {
    const lead = await this.lead(leadId);
    const target = await this.preferredOutboundTarget(lead);
    if (!target) throw new Error('У клиента ещё нет доступного канала для отправки дизайна');
    const assetIds = result.assets.map((asset) => asset.id);
    const mediaHash = createHash('sha256').update(JSON.stringify(assetIds)).digest('hex');
    const caption = String(result.brief.client_caption || result.brief.title || 'Концепции дизайна готовы.')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 900);
    const content = target.channel === 'telegram'
      ? caption
      : `${caption}\n\n${result.assets.map((asset, index) => `Вариант ${index + 1}: ${asset.publicUrl}`).join('\n')}`;
    const hash = createHash('sha256').update(content).digest('hex');
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO drafts(
         lead_id,kind,channel,target_external_id,content,content_hash,
         source_last_message_id,metadata
       ) VALUES($1,'design_concept',$2,$3,$4,$5,$6,$7)
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
          mode: 'design_concept',
          preparedBy: 'telegram_owner',
          mediaAssetIds: target.channel === 'telegram' ? assetIds : [],
          mediaHash,
          visualDirection: String(result.brief.visual_direction || '').slice(0, 2_000),
          rationale: String(result.brief.rationale || '').slice(0, 2_000),
          estimatedCostUsd: result.estimatedCostUsd,
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
      previewUrls: result.assets.map((asset) => asset.publicUrl),
      visualDirection: result.brief.visual_direction,
    };
  }

  async approveOwnerOutbound(ownerExternalId: string, expectedRecipient: string | null = null) {
    const approved = await this.db.transaction(async (client) => {
      const selected = await client.query(
        `SELECT d.id,d.lead_id,d.status,d.source_last_message_id,l.last_inbound_message_id,
                l.title,l.client
         FROM owner_agent_sessions s
         JOIN drafts d ON d.id=s.pending_draft_id
         JOIN leads l ON l.id=d.lead_id
         WHERE s.owner_external_id=$1 FOR UPDATE OF d,s`,
        [ownerExternalId],
      );
      const row = selected.rows[0];
      if (!row) throw new Error('Нет подготовленного ответа. Сначала попросите его написать');
      if (expectedRecipient) {
        const aliases = (await client.query<{ author: string }>(
          `SELECT DISTINCT author FROM messages
           WHERE lead_id=$1 AND author IS NOT NULL AND author<>''
           ORDER BY author LIMIT 30`,
          [row.lead_id],
        )).rows.map((item) => item.author);
        if (!recipientMatchesLead(expectedRecipient, row, aliases)) {
          throw new Error(
            `Подготовлен ответ для «${row.title}», а в команде указан «${expectedRecipient}». Ничего не отправлено.`,
          );
        }
      }
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
        "UPDATE followup_schedule SET status='approved',updated_at=now() WHERE draft_id=$1 AND status='drafted'",
        [row.id],
      );
      await client.query(
        'UPDATE owner_agent_sessions SET pending_draft_id=NULL,updated_at=now() WHERE owner_external_id=$1',
        [ownerExternalId],
      );
      await client.query(
        "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'telegram-owner','draft_approved',$2)",
        [row.lead_id, JSON.stringify({
          draftId: row.id,
          naturalCommand: true,
          expectedRecipient,
        })],
      );
      return { draftId: row.id };
    });
    await this.queue.add(
      'send-draft',
      { draftId: approved.draftId },
      `telegram-owner-send-${approved.draftId}`,
    );
    await this.autonomy.recordOwnerFeedback(approved.draftId, 'approved');
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
      const insertedTurn = await client.query<{ id: string }>(
        `INSERT INTO agent_turns(
           lead_id,source_message_id,channel,stage_before,stage_after,
           intent,reply,summary,decision
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
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
            conversationStage: turn.conversation_stage,
            confidence: turn.confidence,
            nextAction: turn.next_action,
            requiresOwner: turn.requires_owner,
            valueBeforeQuestion: turn.value_before_question,
            ownerBrief: turn.owner_brief,
            replyDeadline: turn.reply_deadline,
            riskFlags: turn.risk_flags,
            discoveryComplete: turn.discovery_complete,
          }),
        ],
      );
      const turnId = insertedTurn.rows[0].id;
      const eventType = turn.requires_owner ? 'owner_escalation'
        : turn.discovery_complete ? 'discovery_completed'
          : turn.conversation_stage;
      await client.query(
        `INSERT INTO lead_episodes(lead_id,source_message_id,event_type,summary,outcome,importance)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          lead.id,
          lead.last_inbound_message_id,
          eventType,
          String(turn.summary || turn.reply).slice(0, 2_000),
          JSON.stringify({ nextAction: turn.next_action, riskFlags: turn.risk_flags, stage: turn.stage }),
          turn.requires_owner || turn.discovery_complete ? 90 : 60,
        ],
      );
      const evals = [
        { name: 'max_one_question', passed: (turn.reply.match(/\?/gu) || []).length <= 1 },
        { name: 'max_500_characters', passed: turn.conversation_stage === 's6_spec_confirmation' || turn.reply.length <= 500 },
        { name: 'commitment_gate', passed: turn.requires_owner || outboundCommitmentIssues(turn.reply).length === 0 },
        { name: 'owner_stop_gate', passed: !turn.risk_flags.length || turn.requires_owner },
      ];
      for (const evaluation of evals) {
        await client.query(
          `INSERT INTO agent_eval_results(lead_id,turn_id,eval_name,passed,details)
           VALUES($1,$2,$3,$4,$5)`,
          [lead.id, turnId, evaluation.name, evaluation.passed, JSON.stringify({ stage: turn.conversation_stage })],
        );
      }
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
    if (channel === 'fl') return String(lead.client?.fl_dialog_id || '') || null;
    if (channel === 'telegram') return String(lead.client?.telegram_chat_id || '') || null;
    if (channel === lead.source) return lead.external_id;
    return null;
  }

  private async preferredOutboundTarget(lead: LeadRow) {
    const linked = await this.db.query<{ channel: string; external_id: string }>(
      `SELECT channel,external_id FROM lead_channels
       WHERE lead_id=$1 AND (
         channel='telegram' OR (channel='fl' AND metadata->>'kind'='dialog')
       )
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

  private normalizeTurn(
    value: ConversationTurn,
    fallbackStage: string,
    policy: ChatPolicySnapshot,
    escalationSeed = '',
    recentReplies: string[] = [],
  ): ConversationTurn {
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
    const confidence = this.percent(value?.confidence);
    const conversationStage = CHAT_STAGES.includes(value?.conversation_stage as ChatStage)
      ? value.conversation_stage as ChatStage
      : policy.conversationStage;
    const stopReasons: ChatStopReason[] = [...policy.stopReasons];
    if (confidence < 60) stopReasons.push('low_confidence');
    if (value?.requires_owner === true && stopReasons.length === 0) stopReasons.push('model_escalation');
    const requiresOwner = stopReasons.length > 0;
    const deadline = requiresOwner ? ownerReplyDeadline() : null;
    const modelReply = String(value?.reply || '').trim();
    const reply = requiresOwner
      ? ownerEscalationReply(Array.from(new Set(stopReasons)), deadline as string, escalationSeed, recentReplies)
      : modelReply;
    const valueBeforeQuestion = requiresOwner ? true : value?.value_before_question === true;
    const reviewIssues = reviewChatReply({
      reply,
      conversationStage,
      valueBeforeQuestion,
      discoveryQuestionsRemaining: policy.discoveryQuestionsRemaining,
      requiresOwner,
      inboundBundle: policy.inboundBundle,
    });
    if (reviewIssues.length) {
      throw new Error(`Ответ чат-агента не прошёл контроль: ${reviewIssues.join(' ')}`);
    }
    return {
      intent: String(value?.intent || 'unknown').slice(0, 100),
      stage,
      conversation_stage: requiresOwner && policy.stopReasons.includes('commitment')
        ? 's7_commercial_owner'
        : conversationStage,
      confidence,
      reply: reply.slice(0, 4_000),
      summary: String(value?.summary || '').slice(0, 8_000),
      next_action: requiresOwner
        ? `Владельцу: проверить запрос клиента и ответить ${deadline}`
        : String(value?.next_action || '').slice(0, 500),
      discovery_readiness: this.percent(value?.discovery_readiness),
      build_readiness: this.percent(value?.build_readiness),
      should_move_to_telegram: !requiresOwner && value?.should_move_to_telegram === true,
      discovery_complete: value?.discovery_complete === true,
      requires_owner: requiresOwner,
      value_before_question: valueBeforeQuestion,
      owner_brief: requiresOwner
        ? String(value?.owner_brief || policy.inboundBundle.join(' | ')).slice(0, 2_000)
        : null,
      reply_deadline: deadline,
      risk_flags: Array.isArray(value?.risk_flags)
        ? [...value.risk_flags.map(String), ...stopReasons].slice(0, 12)
        : stopReasons.slice(0, 12),
      requirements,
    };
  }

  private async recordLatestNegativeReaction(leadId: string) {
    const result = await this.db.query<{ draft_id: string }>(
      `SELECT d.id AS draft_id FROM messages m
       JOIN drafts d ON d.id::text=m.metadata->>'draft_id'
       WHERE m.lead_id=$1 AND m.direction='outbound'
       ORDER BY m.created_at DESC LIMIT 1`,
      [leadId],
    );
    const draftId = result.rows[0]?.draft_id;
    if (draftId) await this.autonomy.recordOwnerFeedback(draftId, 'negative');
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
