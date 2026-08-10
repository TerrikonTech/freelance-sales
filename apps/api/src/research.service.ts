import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { SettingsService } from './settings.service';
import {
  DEFAULT_PRESENCE_PROFILE,
  followupDueAt,
  normalizePresenceProfile,
  presenceAwareReplyDelaySeconds,
  PresenceProfile,
} from './research-controls';

type DueFollowup = {
  id: string;
  lead_id: string;
  touch_no: number;
  channel: string;
  basis_message_id: string;
  title: string;
  target_external_id: string | null;
  source: string;
  client: Record<string, unknown>;
};

@Injectable()
export class ResearchService {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
  ) {}

  async presenceProfile(): Promise<PresenceProfile> {
    const stored = await this.settings.getPublic<Partial<PresenceProfile>>('presence_profile');
    return normalizePresenceProfile(stored || DEFAULT_PRESENCE_PROFILE);
  }

  async setPresenceProfile(value: Partial<PresenceProfile>): Promise<PresenceProfile> {
    const normalized = normalizePresenceProfile(value);
    await this.settings.setPublic('presence_profile', normalized);
    return normalized;
  }

  async autoReplyDelayMs(characters: number, seed: string): Promise<number> {
    return presenceAwareReplyDelaySeconds(characters, seed, new Date(), await this.presenceProfile()) * 1_000;
  }

  async scheduleAfterOutbound(draftId: string): Promise<number> {
    const selected = await this.db.query<{
      lead_id: string;
      channel: string;
      mode: string | null;
      followup_touch: string | null;
      pipeline_stage: string;
      source: string;
      message_id: string | null;
      message_created_at: string | null;
    }>(
      `SELECT d.lead_id,d.channel,d.metadata->>'mode' AS mode,
              d.metadata->>'followup_touch' AS followup_touch,
              l.pipeline_stage,l.source,m.id AS message_id,m.created_at AS message_created_at
       FROM drafts d JOIN leads l ON l.id=d.lead_id
       LEFT JOIN LATERAL (
         SELECT id,created_at FROM messages
         WHERE lead_id=d.lead_id AND direction='outbound' AND metadata->>'draft_id'=d.id::text
         ORDER BY created_at DESC LIMIT 1
       ) m ON true
       WHERE d.id=$1 AND d.status='sent'`,
      [draftId],
    );
    const row = selected.rows[0];
    if (!row?.message_id || row.mode !== 'chat' || row.followup_touch || row.source === 'sandbox') return 0;
    if (!['contacted', 'discovery', 'proposal', 'negotiation', 'telegram_handoff', 'contract'].includes(row.pipeline_stage)) return 0;
    const profile = await this.presenceProfile();
    const basis = new Date(row.message_created_at as string);
    return this.db.transaction(async (client) => {
      await client.query(
        `UPDATE followup_schedule SET status='cancelled',cancel_reason='new_outbound',updated_at=now()
         WHERE lead_id=$1 AND status IN ('pending','drafting','drafted')`,
        [row.lead_id],
      );
      let created = 0;
      for (const touch of [1, 2, 3]) {
        const dueAt = followupDueAt(basis, touch, `${row.lead_id}:${row.message_id}`, profile);
        const result = await client.query(
          `INSERT INTO followup_schedule(lead_id,basis_message_id,touch_no,channel,due_at)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
          [row.lead_id, row.message_id, touch, row.channel, dueAt],
        );
        created += result.rowCount || 0;
      }
      return created;
    });
  }

  async claimDueFollowup(): Promise<DueFollowup | null> {
    const profile = await this.presenceProfile();
    const draftedToday = Number((await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM followup_schedule
       WHERE status IN ('drafting','drafted','approved','sent')
         AND updated_at >= date_trunc('day',now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'`,
    )).rows[0]?.count || 0);
    if (draftedToday >= profile.dailyInitiativeLimit) return null;

    const result = await this.db.query<DueFollowup>(
      `WITH chosen AS (
         SELECT f.id FROM followup_schedule f
         JOIN leads l ON l.id=f.lead_id
         WHERE f.status='pending' AND f.due_at<=now() AND l.source<>'sandbox'
           AND l.pipeline_stage IN ('contacted','discovery','proposal','negotiation','telegram_handoff','contract')
           AND l.status NOT IN ('won','lost','rejected')
         ORDER BY f.due_at LIMIT 1 FOR UPDATE OF f SKIP LOCKED
       ), claimed AS (
         UPDATE followup_schedule f SET status='drafting',updated_at=now()
         FROM chosen WHERE f.id=chosen.id
         RETURNING f.*
       )
       SELECT c.id,c.lead_id,c.touch_no,c.channel,c.basis_message_id,
              l.title,l.source,l.client,
              CASE c.channel
                WHEN 'telegram' THEN COALESCE(NULLIF(l.client->>'telegram_chat_id',''),lc.external_id)
                WHEN 'fl' THEN COALESCE(NULLIF(l.client->>'fl_dialog_id',''),lc.external_id)
                ELSE lc.external_id
              END AS target_external_id
       FROM claimed c JOIN leads l ON l.id=c.lead_id
       LEFT JOIN LATERAL (
         SELECT external_id FROM lead_channels
         WHERE lead_id=l.id AND channel=c.channel ORDER BY last_seen_at DESC LIMIT 1
       ) lc ON true`,
    );
    const row = result.rows[0];
    if (!row) return null;

    const changed = await this.db.query(
      `SELECT 1 FROM messages basis JOIN messages incoming ON incoming.lead_id=basis.lead_id
       WHERE basis.id=$1 AND incoming.direction='inbound' AND incoming.created_at>basis.created_at LIMIT 1`,
      [row.basis_message_id],
    );
    if (changed.rows[0]) {
      await this.db.query(
        `UPDATE followup_schedule SET status='cancelled',cancel_reason='client_replied',updated_at=now()
         WHERE lead_id=$1 AND status IN ('pending','drafting')`,
        [row.lead_id],
      );
      return null;
    }
    if (!row.target_external_id) {
      await this.cancelFollowup(row.id, 'target_missing');
      return null;
    }
    return row;
  }

  async markFollowupDrafted(id: string, draftId: string) {
    await this.db.query(
      `UPDATE followup_schedule SET status='drafted',draft_id=$2,updated_at=now()
       WHERE id=$1 AND status='drafting'`,
      [id, draftId],
    );
  }

  async cancelFollowup(id: string, reason: string) {
    await this.db.query(
      `UPDATE followup_schedule SET status='cancelled',cancel_reason=$2,updated_at=now()
       WHERE id=$1 AND status IN ('pending','drafting')`,
      [id, reason.slice(0, 300)],
    );
  }

  async overview() {
    const [funnel, followups, evals, autonomy, costs, episodes, humanity] = await Promise.all([
      this.db.query(`WITH proposals AS (
          SELECT DISTINCT d.lead_id,min(d.sent_at) AS sent_at
          FROM drafts d JOIN leads l ON l.id=d.lead_id
          WHERE d.status='sent' AND d.metadata->>'mode'='response' AND l.source<>'sandbox'
          GROUP BY d.lead_id
        ) SELECT
          count(*)::text AS proposals,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM messages m WHERE m.lead_id=p.lead_id AND m.direction='inbound' AND m.created_at>p.sent_at
          ))::text AS replied,
          count(*) FILTER (WHERE (SELECT count(*) FROM messages m WHERE m.lead_id=p.lead_id AND m.direction='inbound')>=3)::text AS engaged,
          count(*) FILTER (WHERE l.discovery_readiness>=70)::text AS discovery_complete,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM conversation_handoffs h WHERE h.lead_id=p.lead_id AND h.status='used'))::text AS handoff,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM documents d WHERE d.lead_id=p.lead_id AND d.kind='specification'))::text AS specification,
          count(*) FILTER (WHERE l.status='won' OR l.pipeline_stage='won')::text AS won
        FROM proposals p JOIN leads l ON l.id=p.lead_id`),
      this.db.query(`SELECT
          count(*) FILTER (WHERE status='pending')::text AS pending,
          count(*) FILTER (WHERE status='drafted')::text AS drafted,
          count(*) FILTER (WHERE status='sent')::text AS sent,
          count(*) FILTER (WHERE status='cancelled' AND cancel_reason='client_replied')::text AS cancelled_by_reply
        FROM followup_schedule`),
      this.db.query(`SELECT count(*)::text AS total,
          count(*) FILTER (WHERE passed)::text AS passed,
          count(*) FILTER (WHERE NOT passed)::text AS failed
        FROM agent_eval_results WHERE created_at>=now()-interval '30 days'`),
      this.db.query(`SELECT class,shown,approved_asis,edited,rejected,negative_reactions,
          auto_enabled,unlocked_at,disabled_reason FROM autonomy_class_stats ORDER BY class`),
      this.db.query(`SELECT count(*)::text AS tasks,
          COALESCE(sum(duration_ms),0)::text AS duration_ms,
          COALESCE(sum(estimated_cost_usd),0)::text AS estimated_cost_usd,
          count(*) FILTER (WHERE estimated_cost_usd IS NULL)::text AS cost_unknown
        FROM ai_tasks WHERE created_at>=now()-interval '30 days'`),
      this.db.query(`SELECT count(*)::text AS total,count(DISTINCT lead_id)::text AS leads FROM lead_episodes`),
      this.db.query(`WITH measured AS (
          SELECT d.lead_id,d.sent_at,
            NULLIF(d.metadata->'review'->'humanity_metrics'->>'burstiness','')::numeric AS burstiness,
            NULLIF(d.metadata->'review'->'humanity_metrics'->>'clientAddressCount','')::numeric AS addresses,
            COALESCE((d.metadata->'review'->'humanity_metrics'->>'humanRulePass')::boolean,false) AS human_pass
          FROM drafts d JOIN leads l ON l.id=d.lead_id
          WHERE d.status='sent' AND d.metadata->>'mode'='response' AND l.source<>'sandbox'
            AND d.metadata->'review'->'humanity_metrics' IS NOT NULL
        ) SELECT count(*)::text AS measured,
          round(COALESCE(avg(burstiness),0),2)::text AS avg_burstiness,
          round(COALESCE(avg(addresses),0),2)::text AS avg_addresses,
          count(*) FILTER (WHERE human_pass)::text AS human_pass,
          count(*) FILTER (WHERE burstiness>=0.60)::text AS target_burstiness,
          count(*) FILTER (WHERE burstiness>=0.60 AND EXISTS (
            SELECT 1 FROM messages m WHERE m.lead_id=measured.lead_id
              AND m.direction='inbound' AND m.created_at>measured.sent_at
          ))::text AS high_burst_replied,
          count(*) FILTER (WHERE burstiness>=0.60)::text AS high_burst_total,
          count(*) FILTER (WHERE burstiness<0.60 AND EXISTS (
            SELECT 1 FROM messages m WHERE m.lead_id=measured.lead_id
              AND m.direction='inbound' AND m.created_at>measured.sent_at
          ))::text AS low_burst_replied,
          count(*) FILTER (WHERE burstiness<0.60)::text AS low_burst_total
        FROM measured`),
    ]);
    return {
      funnel: funnel.rows[0],
      followups: followups.rows[0],
      evals: evals.rows[0],
      autonomyClasses: autonomy.rows,
      aiEconomics: costs.rows[0],
      memory: episodes.rows[0],
      proposalHumanity: humanity.rows[0],
      presence: await this.presenceProfile(),
      safety: {
        flManualApprovalPermanent: true,
        telegramClassGates: true,
        scheduledFollowupsAreDrafts: true,
      },
    };
  }
}
