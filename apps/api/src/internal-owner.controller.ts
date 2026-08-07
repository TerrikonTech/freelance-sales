import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { AutonomyService } from './autonomy.service';
import { DatabaseService } from './database.service';
import { QueueService } from './queue.service';

type OwnerAction = 'approve' | 'skip' | 'pause' | 'resume' | 'status' | 'review';

type PendingDecisionRow = {
  decision_id: string;
  lead_id: string;
  draft_id: string;
  title: string;
  channel: string;
  content: string;
  reason: string;
  confidence: string | number;
  created_at: string;
};

type OwnerNotificationRow = PendingDecisionRow & {
  notification_id: string;
};

@Controller('api/internal/owner')
export class InternalOwnerController {
  constructor(
    private readonly db: DatabaseService,
    private readonly queue: QueueService,
    private readonly autonomy: AutonomyService,
  ) {}

  @Get('summary')
  async summary(
    @Headers('x-sales-broker-token') brokerToken?: string,
    @Headers('x-sales-owner-token') ownerToken?: string,
  ) {
    this.authorize(brokerToken, ownerToken);
    return this.buildSummary();
  }

  @Post('actions')
  async action(
    @Headers('x-sales-broker-token') brokerToken: string | undefined,
    @Headers('x-sales-owner-token') ownerToken: string | undefined,
    @Body() body: { action?: OwnerAction; decisionId?: string | null },
  ) {
    this.authorize(brokerToken, ownerToken);
    const action = String(body.action || '') as OwnerAction;
    if (!['approve', 'skip', 'pause', 'resume', 'status', 'review'].includes(action)) {
      throw new BadRequestException('Неизвестное действие');
    }

    if (action === 'status' || action === 'review') return this.buildSummary();
    if ((action === 'pause' || action === 'resume') && !body.decisionId) {
      await this.autonomy.setPolicy({ globalPaused: action === 'pause' });
      return this.buildSummary(action === 'pause' ? 'Автоответы остановлены' : 'Автоответы возобновлены');
    }

    const decisionId = this.requireDecisionId(body.decisionId);
    if (action === 'approve') return this.approve(decisionId);
    if (action === 'skip') return this.skip(decisionId);
    if (action === 'pause') return this.pauseLead(decisionId);
    throw new BadRequestException('Для этого действия не нужен идентификатор решения');
  }

  @Get('notifications/claim')
  async claimNotification(
    @Headers('x-sales-broker-token') brokerToken?: string,
    @Headers('x-sales-owner-token') ownerToken?: string,
  ) {
    this.authorize(brokerToken, ownerToken);
    await this.seedNotifications();
    const claimed = await this.db.transaction(async (client) => {
      const result = await client.query<OwnerNotificationRow>(
        `UPDATE owner_notifications SET status='claimed',claimed_at=now(),updated_at=now()
         WHERE id=(
           SELECT n.id FROM owner_notifications n
           JOIN autonomy_decisions a ON a.id=n.decision_id
           JOIN drafts d ON d.id=a.draft_id
           JOIN leads l ON l.id=a.lead_id
           WHERE n.status='pending' AND a.decision='ask_owner' AND d.status='pending' AND l.source<>'sandbox'
           ORDER BY n.created_at
           FOR UPDATE OF n SKIP LOCKED
           LIMIT 1
         )
         RETURNING
           id AS notification_id,
           decision_id,
           (SELECT lead_id FROM autonomy_decisions WHERE id=decision_id) AS lead_id,
           (SELECT draft_id FROM autonomy_decisions WHERE id=decision_id) AS draft_id,
           (SELECT l.title FROM autonomy_decisions a JOIN leads l ON l.id=a.lead_id WHERE a.id=decision_id) AS title,
           (SELECT d.channel FROM autonomy_decisions a JOIN drafts d ON d.id=a.draft_id WHERE a.id=decision_id) AS channel,
           (SELECT d.content FROM autonomy_decisions a JOIN drafts d ON d.id=a.draft_id WHERE a.id=decision_id) AS content,
           (SELECT reason FROM autonomy_decisions WHERE id=decision_id) AS reason,
           (SELECT confidence FROM autonomy_decisions WHERE id=decision_id) AS confidence,
           created_at`,
      );
      return result.rows[0] || null;
    });
    return { notification: claimed ? this.notificationPayload(claimed) : null };
  }

  @Post('notifications/:id/sent')
  async notificationSent(
    @Headers('x-sales-broker-token') brokerToken: string | undefined,
    @Headers('x-sales-owner-token') ownerToken: string | undefined,
    @Param('id') id: string,
    @Body() body: { externalId?: string | null },
  ) {
    this.authorize(brokerToken, ownerToken);
    const result = await this.db.query(
      `UPDATE owner_notifications
       SET status='sent',external_id=$2,sent_at=now(),updated_at=now()
       WHERE id=$1 AND status='claimed' RETURNING id`,
      [id, String(body.externalId || '').slice(0, 200) || null],
    );
    if (!result.rows[0]) throw new ConflictException('Уведомление уже обработано');
    return { ok: true };
  }

  @Post('notifications/:id/fail')
  async notificationFailed(
    @Headers('x-sales-broker-token') brokerToken: string | undefined,
    @Headers('x-sales-owner-token') ownerToken: string | undefined,
    @Param('id') id: string,
    @Body() body: { error?: string },
  ) {
    this.authorize(brokerToken, ownerToken);
    await this.db.query(
      `UPDATE owner_notifications
       SET status='failed',error=$2,updated_at=now()
       WHERE id=$1 AND status='claimed'`,
      [id, String(body.error || 'Не удалось доставить уведомление').slice(0, 500)],
    );
    return { ok: true };
  }

  private async buildSummary(message = '') {
    const [policy, pending] = await Promise.all([
      this.autonomy.getPolicy(),
      this.db.query<PendingDecisionRow>(
        `SELECT
           a.id AS decision_id,a.lead_id,a.draft_id,l.title,d.channel,d.content,
           a.reason,a.confidence,a.created_at
         FROM autonomy_decisions a
         JOIN leads l ON l.id=a.lead_id
         JOIN drafts d ON d.id=a.draft_id
         WHERE a.decision='ask_owner' AND d.status='pending' AND l.source<>'sandbox'
         ORDER BY a.created_at DESC
         LIMIT 10`,
      ),
    ]);
    return {
      paused: policy.globalPaused,
      pendingCount: pending.rowCount || 0,
      pending: pending.rows.map((row) => ({
        decisionId: row.decision_id,
        title: row.title,
        summary: row.reason,
        channel: row.channel,
        recommendation: row.content.slice(0, 1200),
        confidence: Number(row.confidence),
      })),
      message: message || (pending.rowCount ? 'Есть ответы, которые ждут решения' : 'Новых решений нет'),
      status: policy.mode === 'smart' ? 'smart' : 'manual',
    };
  }

  private async approve(decisionId: string) {
    const approved = await this.db.transaction(async (client) => {
      const result = await client.query(
        `SELECT a.id,a.lead_id,a.draft_id,a.decision,d.status,d.source_last_message_id,
                l.last_inbound_message_id,d.content_hash
         FROM autonomy_decisions a
         JOIN drafts d ON d.id=a.draft_id
         JOIN leads l ON l.id=a.lead_id
         WHERE a.id=$1
         FOR UPDATE OF a,d`,
        [decisionId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException('Решение не найдено');
      if (row.decision !== 'ask_owner') throw new ConflictException('Решение не ждёт владельца');
      if (row.status !== 'pending') return { draftId: row.draft_id, alreadyHandled: true };
      if ((row.source_last_message_id || null) !== (row.last_inbound_message_id || null)) {
        await client.query("UPDATE drafts SET status='stale',updated_at=now() WHERE id=$1", [row.draft_id]);
        throw new ConflictException('Появилось новое сообщение — нужен свежий ответ');
      }
      await client.query(
        `UPDATE drafts SET status='approved',approved_at=now(),
         metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('approved_via','telegram_owner'),
         updated_at=now() WHERE id=$1`,
        [row.draft_id],
      );
      await client.query(
        "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'telegram-owner','draft_approved',$2)",
        [row.lead_id, JSON.stringify({ draftId: row.draft_id, decisionId, hash: row.content_hash })],
      );
      await client.query(
        "UPDATE owner_notifications SET status='actioned',updated_at=now() WHERE decision_id=$1 AND status IN ('pending','claimed','sent','failed')",
        [decisionId],
      );
      return { draftId: row.draft_id, alreadyHandled: false };
    });
    if (!approved.alreadyHandled) {
      await this.queue.add('send-draft', { draftId: approved.draftId }, `owner-send-${approved.draftId}`);
    }
    return { ok: true, queued: !approved.alreadyHandled, message: approved.alreadyHandled ? 'Уже обработано' : 'Ответ одобрен и поставлен на отправку' };
  }

  private async skip(decisionId: string) {
    const result = await this.db.transaction(async (client) => {
      const selected = await client.query(
        `SELECT a.lead_id,a.draft_id,d.status
         FROM autonomy_decisions a JOIN drafts d ON d.id=a.draft_id
         WHERE a.id=$1 FOR UPDATE OF d`,
        [decisionId],
      );
      const row = selected.rows[0];
      if (!row) throw new NotFoundException('Решение не найдено');
      if (row.status === 'pending') {
        await client.query("UPDATE drafts SET status='rejected',updated_at=now() WHERE id=$1", [row.draft_id]);
        await client.query(
          "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'telegram-owner','draft_rejected',$2)",
          [row.lead_id, JSON.stringify({ draftId: row.draft_id, decisionId })],
        );
      }
      await client.query(
        "UPDATE owner_notifications SET status='actioned',updated_at=now() WHERE decision_id=$1 AND status IN ('pending','claimed','sent','failed')",
        [decisionId],
      );
      return row.status === 'pending';
    });
    return { ok: true, skipped: result, message: result ? 'Ответ пропущен' : 'Уже обработано' };
  }

  private async pauseLead(decisionId: string) {
    const row = (await this.db.query<{ lead_id: string }>(
      'SELECT lead_id FROM autonomy_decisions WHERE id=$1',
      [decisionId],
    )).rows[0];
    if (!row) throw new NotFoundException('Решение не найдено');
    await this.autonomy.pauseClient(row.lead_id, true, 'Пауза из Telegram владельца');
    await this.db.query(
      "UPDATE owner_notifications SET status='actioned',updated_at=now() WHERE decision_id=$1 AND status IN ('pending','claimed','sent','failed')",
      [decisionId],
    );
    return { ok: true, paused: true, message: 'Диалог с клиентом поставлен на паузу' };
  }

  private async seedNotifications() {
    await this.db.query(
      `INSERT INTO owner_notifications(decision_id)
       SELECT a.id
       FROM autonomy_decisions a
       JOIN drafts d ON d.id=a.draft_id
       JOIN leads l ON l.id=a.lead_id
       WHERE a.decision='ask_owner' AND d.status='pending' AND l.source<>'sandbox'
       ON CONFLICT(decision_id) DO NOTHING`,
    );
  }

  private notificationPayload(row: OwnerNotificationRow) {
    return {
      id: row.notification_id,
      decisionId: row.decision_id,
      leadId: row.lead_id,
      draftId: row.draft_id,
      title: row.title,
      channel: row.channel,
      reason: row.reason,
      confidence: Number(row.confidence),
      recommendation: row.content.slice(0, 2400),
    };
  }

  private requireDecisionId(value: string | null | undefined): string {
    const id = String(value || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
      throw new BadRequestException('Некорректный decisionId');
    }
    return id;
  }

  private authorize(brokerToken?: string, ownerToken?: string) {
    const accepted = [
      [String(brokerToken || ''), String(process.env.SALES_BROKER_TOKEN || '')],
      [String(ownerToken || ''), String(process.env.SALES_OWNER_TOKEN || '')],
    ].some(([provided, expected]) => {
      if (!provided || !expected) return false;
      const left = Buffer.from(provided);
      const right = Buffer.from(expected);
      return left.length === right.length && timingSafeEqual(left, right);
    });
    if (!accepted) {
      throw new UnauthorizedException();
    }
  }
}
