import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { createHash } from 'node:crypto';
import { AiService, ProposalQualityError } from './ai.service';
import { AutonomyService } from './autonomy.service';
import { DatabaseService } from './database.service';
import { DesignConceptService } from './design-concept.service';
import { DocumentsService } from './documents.service';
import { FlService } from './fl.service';
import { JobProgressService } from './job-progress.service';
import { QueueService } from './queue.service';
import { followupInstruction } from './research-controls';
import { ResearchService } from './research.service';
import { SalesAgentService } from './sales-agent.service';
import { isSandboxLead } from './sandbox';
import { PushService } from './push.service';
import { TelegramService } from './telegram.service';
import { isDeliveryUnknown, OutboundPreflightError } from './outbound-errors';

export function resolveDraftMode(
  channel: string,
  requestedMode: string,
  hasFlDialog: boolean,
): 'chat' | 'response' {
  if (requestedMode === 'chat' || requestedMode === 'response') return requestedMode;
  if (channel === 'telegram') return 'chat';
  return hasFlDialog ? 'chat' : 'response';
}

@Injectable()
export class ProcessorService implements OnModuleDestroy {
  private readonly logger = new Logger(ProcessorService.name);
  private worker?: Worker;
  private scanTimer?: NodeJS.Timeout;
  private portfolioTimer?: NodeJS.Timeout;
  private chatTimer?: NodeJS.Timeout;
  private announceTimer?: NodeJS.Timeout;
  private researchTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private connection?: IORedis;
  private scanInProgress = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly ai: AiService,
    private readonly design: DesignConceptService,
    private readonly docs: DocumentsService,
    private readonly fl: FlService,
    private readonly telegram: TelegramService,
    private readonly queue: QueueService,
    private readonly push: PushService,
    private readonly autonomy: AutonomyService,
    private readonly salesAgent: SalesAgentService,
    private readonly research: ResearchService,
    private readonly progress: JobProgressService,
  ) {}

  async start() {
    await this.progress.sweep().catch((error) => this.logger.warn(
      `Progress sweep skipped: ${error instanceof Error ? error.message : 'unknown'}`,
    ));
    await this.recoverAmbiguousDeliveries();
    this.connection = new IORedis(process.env.REDIS_URL || 'redis://redis:6379', { maxRetriesPerRequest: null });
    // The interface has no other way to tell "worker is alive but idle" from
    // "worker is dead", and a silent worker looks exactly like a broken button.
    const beat = () => { void this.connection?.set('worker:heartbeat', String(Date.now()), 'EX', 180).catch(() => undefined); };
    beat();
    this.heartbeatTimer = setInterval(beat, 30_000);
    this.worker = new Worker('sales', (job) => this.process(job), {
      connection: this.connection,
      concurrency: 3,
      lockDuration: 25 * 60_000,
      stalledInterval: 60_000,
      maxStalledCount: 1,
    });
    this.worker.on('failed', (job, error) => this.logger.error(`Job ${job?.name || 'unknown'} failed: ${error.message}`));
    const scanInterval = Math.max(15, Number(process.env.FL_SCAN_INTERVAL_SECONDS || 30)) * 1_000;
    const portfolioCheckInterval = 30 * 60_000;
    const scheduleScan = async () => {
      const bucket = Math.floor(Date.now() / scanInterval);
      await this.queue.add('scan-fl', {}, `scan-${bucket}`).catch((error) => this.logger.warn(error.message));
    };
    const schedulePortfolio = async () => {
      const bucket = Math.floor(Date.now() / portfolioCheckInterval);
      await this.queue.add('sync-fl-portfolio', {}, `sync-fl-portfolio-${bucket}`).catch((error) => this.logger.warn(error.message));
    };
    // FL chat polling was removed with the chats tab: every run died on a
    // navigation timeout and spammed the log with a page nobody looked at.
    this.scanTimer = setInterval(scheduleScan, scanInterval);
    this.portfolioTimer = setInterval(schedulePortfolio, portfolioCheckInterval);
    await Promise.all([scheduleScan(), schedulePortfolio()]);
    // The owner's own session finishes handed-off sends, so nothing in this process
    // ever learns the outcome. Poll fast and keep the promise the bot already made.
    this.announceTimer = setInterval(
      () => this.announceHandedOffDeliveries().catch((error) => this.logger.warn(
        `Handed-off delivery announcement skipped: ${error instanceof Error ? error.message : 'unknown'}`,
      )),
      15_000,
    );
    const scheduleResearchJobs = async () => {
      const bucket = Math.floor(Date.now() / 300_000);
      await Promise.all([
        this.queue.add('process-followups', {}, `followups-${bucket}`),
        this.queue.add('health-watchdog', {}, `health-watchdog-${bucket}`),
      ]).catch((error) => this.logger.warn(error instanceof Error ? error.message : 'Research scheduler failed'));
    };
    this.researchTimer = setInterval(scheduleResearchJobs, 300_000);
    await scheduleResearchJobs();
    this.logger.log('Worker started');
  }

  /**
   * Deliveries the bot could not make itself are completed by the owner's Telegram session.
   * That path updates the database directly, so without this the owner is told
   * "I will report back" and then never hears the outcome.
   */
  private async announceHandedOffDeliveries() {
    const claimed = await this.db.query<{
      id: string;
      draft_id: string;
      channel: string;
      status: string;
      error: string | null;
      lead_title: string;
    }>(
      `UPDATE outbound_deliveries SET error = coalesce(error,'') || ' [userbot] announced',
         updated_at = now()
       WHERE id IN (
         SELECT id FROM outbound_deliveries
         WHERE error LIKE '%[userbot] delivered%' OR error LIKE '%[userbot] outbox %'
         ORDER BY updated_at LIMIT 10
       )
       AND error NOT LIKE '%[userbot] announced%'
       RETURNING id, draft_id, channel, status, error,
         (SELECT COALESCE(l.client->>'name', l.title, 'клиент')
            FROM leads l WHERE l.id = outbound_deliveries.lead_id) AS lead_title`,
    );
    for (const row of claimed.rows) {
      const delivered = /\[userbot\] delivered/i.test(String(row.error || ''));
      await this.telegram.notifyOwnerDeliveryResult({
        status: delivered ? 'sent' : 'failed',
        leadTitle: row.lead_title,
        channel: row.channel,
        error: delivered
          ? row.error
          : `отправка с вашего аккаунта не прошла: ${String(row.error || '').slice(-200)}`,
      });
      if (delivered) {
        await this.research.scheduleAfterOutbound(row.draft_id)
          .catch((error) => this.logger.warn(`Follow-up schedule skipped: ${error instanceof Error ? error.message : 'unknown'}`));
      }
      this.logger.log(`Reported handed-off delivery ${row.id} as ${delivered ? 'sent' : 'failed'}`);
    }
    return claimed.rows.length;
  }

  private async recoverAmbiguousDeliveries() {
    const recovered = await this.db.transaction(async (client) => {
      const result = await client.query<{ id: string; draft_id: string; lead_id: string }>(
        `UPDATE outbound_deliveries SET status='send_unknown',
         error=COALESCE(error,'Worker restarted before the remote channel confirmed delivery'),
         completed_at=now(),updated_at=now()
         WHERE status='sending'
         RETURNING id,draft_id,lead_id`,
      );
      for (const delivery of result.rows) {
        await client.query(
          `UPDATE drafts SET status='send_unknown',
           error='Процесс прервался во время отправки; проверьте канал вручную',updated_at=now()
           WHERE id=$1 AND status='sending'`,
          [delivery.draft_id],
        );
        await client.query(
          "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'system','outbound_send_unknown',$2)",
          [delivery.lead_id, JSON.stringify({ draftId: delivery.draft_id, deliveryId: delivery.id, reason: 'worker_restart' })],
        );
      }
      return result.rowCount || 0;
    });
    if (recovered > 0) {
      this.logger.warn(`Marked ${recovered} interrupted outbound deliveries as send_unknown`);
      await this.push.notify(
        'Проверьте исходящие сообщения',
        `${recovered} отправок прервались без подтверждения; автоматический повтор отключён.`,
        '/sales/?page=approvals',
      ).catch((error) => this.logger.warn(`Push skipped: ${error instanceof Error ? error.message : 'unknown'}`));
    }
  }

  /**
   * Background jobs the owner starts by hand get a visible progress row; the periodic
   * housekeeping ones do not, so the feed stays readable.
   */
  private static readonly TRACKED_JOBS = new Set([
    'analyze-lead', 'draft-reply', 'generate-documents', 'generate-design', 'send-draft', 'owner-command',
  ]);

  /**
   * Failures that will repeat identically no matter how often they are replayed.
   * BullMQ retries a draft three times, so treating these as transient made the owner
   * wait roughly ten minutes for an outcome that was already decided in the first three.
   */
  private static readonly PERMANENT_FAILURES = [
    'exceeds the Hermes input limit',
    'exceed the Hermes instruction limit',
    'не прошёл финальную проверку качества',
    'не поддерживается',
    'Текст изменён после одобрения',
    'Состав изображений изменён после одобрения',
    // The broker rejects unknown task kinds instantly; replaying cannot help.
    'Unsupported AI task kind',
  ];

  static isPermanentFailure(message: string) {
    return ProcessorService.PERMANENT_FAILURES.some((marker) => message.includes(marker));
  }

  async process(job: Job) {
    if (!ProcessorService.TRACKED_JOBS.has(job.name)) return this.run(job);
    const leadId = await this.jobLeadId(job);
    try {
      return await this.progress.track(job.name, { leadId }, () => this.run(job));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
      // A slot is spent when the draft is queued, so a draft that never materialised
      // must give it back — otherwise ten broker failures cost a whole day of replies.
      if (job.name === 'draft-reply' && String(job.id || '').startsWith('initial-draft-')) await this.refundAutoDraft();
      if (ProcessorService.isPermanentFailure(message)) {
        this.logger.warn(`Job ${job.name} failed permanently, replay disabled: ${message}`);
        throw new UnrecoverableError(message);
      }
      throw error;
    }
  }

  /** One shared counter per day so a worker restart cannot reset the budget. */
  private async autoDraftBudgetLeft(limit: number): Promise<boolean> {
    if (!limit || !this.connection) return true;
    const key = `auto-draft:${new Date().toISOString().slice(0, 10)}`;
    try {
      const used = Number(await this.connection.get(key)) || 0;
      if (used >= limit) return false;
      await this.connection.incr(key);
      await this.connection.expire(key, 2 * 24 * 3600);
      return true;
    } catch (error) {
      this.logger.warn(`Auto-draft budget check failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return true;
    }
  }

  /** Gives the daily auto-draft slot back when the queued draft never became a draft. */
  private async refundAutoDraft() {
    if (!this.connection) return;
    const key = `auto-draft:${new Date().toISOString().slice(0, 10)}`;
    try {
      if ((Number(await this.connection.get(key)) || 0) > 0) await this.connection.decr(key);
    } catch (error) {
      this.logger.warn(`Auto-draft refund failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private async jobLeadId(job: Job): Promise<string | null> {
    const direct = String(job.data?.leadId || '');
    if (direct) return direct;
    const draftId = String(job.data?.draftId || '');
    if (!draftId) return null;
    const row = await this.db.query<{ lead_id: string }>('SELECT lead_id FROM drafts WHERE id=$1', [draftId])
      .catch(() => ({ rows: [] as Array<{ lead_id: string }> }));
    return row.rows[0]?.lead_id || null;
  }

  private async run(job: Job) {
    switch (job.name) {
      case 'scan-fl': return this.scanFl();
      case 'sync-fl-portfolio': return this.fl.syncPortfolioIfDue();
      case 'owner-command': return this.telegram.processOwnerMessage(job.data.message || {});
      case 'analyze-lead': return this.analyze(String(job.data.leadId), Boolean(job.data.force));
      case 'draft-reply': return this.draft(
        String(job.data.leadId),
        String(job.data.channel || 'fl'),
        String(job.data.targetExternalId || ''),
        String(job.data.mode || ''),
        String(job.data.ownerInstructions || ''),
        Boolean(job.data.ownerRequested),
        String(job.data.automationClass || ''),
        String(job.data.followupId || ''),
        Number(job.data.followupTouch || 0),
        Boolean(job.data.sendImmediately),
      );
      case 'generate-documents': return this.generateDocuments(String(job.data.leadId));
      case 'generate-design': return this.generateDesign(job);
      case 'send-draft': return this.sendDraft(String(job.data.draftId));
      case 'process-followups': return this.processFollowups();
      case 'health-watchdog': return this.healthWatchdog();
      default: throw new Error(`Unknown job ${job.name}`);
    }
  }

  private async scanFl() {
    if (this.scanInProgress) return { skipped: true, reason: 'scan_in_progress' };
    this.scanInProgress = true;
    try {
      return await this.fl.scan();
    } finally {
      this.scanInProgress = false;
    }
  }

  private async generateDesign(job: Job) {
    const leadId = String(job.data.leadId || '');
    const ownerExternalId = String(job.data.ownerExternalId || '');
    const lead = (await this.db.query<{ title: string; source: string; client: unknown }>('SELECT title,source,client FROM leads WHERE id=$1', [leadId])).rows[0];
    const sandbox = isSandboxLead(lead);
    if (!lead || (!ownerExternalId && !sandbox)) return { failed: true, error: 'Клиент или владелец не найден' };
    try {
      const result = await this.design.generate(
        leadId,
        String(job.data.instructions || ''),
        job.data.referenceUrl ? String(job.data.referenceUrl) : null,
        Number(job.data.count || 4),
      );
      if (sandbox) {
        await this.db.query(
          "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'sandbox','sandbox_design_ready',$2)",
          [leadId, JSON.stringify({ assets: result.assets.length, externalNotificationBlocked: true })],
        );
        return { ok: true, sandbox: true, assets: result.assets.length };
      }
      const prepared = await this.salesAgent.prepareDesignOutbound(ownerExternalId, leadId, result);
      await this.telegram.notifyOwnerDesignReady({
        ownerExternalId,
        leadTitle: prepared.leadTitle,
        content: prepared.content,
        previewUrls: prepared.previewUrls,
        visualDirection: prepared.visualDirection,
      });
      await this.db.query(
        "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'ai','design_concept_ready',$2)",
        [leadId, JSON.stringify({ draftId: prepared.draftId, assets: result.assets.length })],
      );
      return { ok: true, draftId: prepared.draftId, assets: result.assets.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
      if (!sandbox) {
        await this.telegram.notifyOwnerDesignFailure(ownerExternalId, lead.title, message)
          .catch((notifyError) => this.logger.warn(
            `Design failure notification skipped: ${notifyError instanceof Error ? notifyError.message : 'unknown'}`,
          ));
      }
      await this.db.query(
        "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'system','design_concept_failed',$2)",
        [leadId, JSON.stringify({ error: message.slice(0, 1_000), automaticRetry: false })],
      );
      return { failed: true, error: message };
    }
  }

  private async analyze(leadId: string, force = false) {
    let lead = (await this.db.query('SELECT * FROM leads WHERE id=$1', [leadId])).rows[0];
    if (!lead) return;
    const hasDetails = Boolean(lead.requirements?.project?.detail_parsed_at);
    const initialFingerprint = hasDetails ? this.ai.analysisFingerprint(lead) : null;
    if (!force && lead.analysis_state === 'completed' && initialFingerprint === lead.analysis_fingerprint) {
      return { skipped: true, reason: 'unchanged_fingerprint' };
    }
    if (!force && !lead.analysis_fingerprint && lead.score !== null && lead.status !== 'new') {
      return { skipped: true, reason: 'legacy_already_analyzed' };
    }

    const claimed = await this.db.query(
      `UPDATE leads SET analysis_state='running',analysis_started_at=now(),updated_at=now()
       WHERE id=$1 AND NOT (
         analysis_state='running' AND analysis_started_at > now()-interval '20 minutes'
       )
       RETURNING id`,
      [leadId],
    );
    if (!claimed.rows[0]) return { skipped: true, reason: 'analysis_in_progress' };

    try {
      if (lead.source === 'fl' && lead.url && (force || !hasDetails)) {
        await this.fl.enrichLead(leadId).catch((error) => this.logger.warn(`FL detail enrichment skipped: ${error instanceof Error ? error.message : 'unknown'}`));
        lead = (await this.db.query('SELECT * FROM leads WHERE id=$1', [leadId])).rows[0];
      }
      const fingerprint = this.ai.analysisFingerprint(lead);
      const localAnalysis = this.ai.prefilterLead(lead);
      const analysis = localAnalysis || await this.ai.analyzeLead(lead);
      const analysisMode = localAnalysis ? 'local_prefilter' : 'gpt_single_pass';
      // Квалификация по крупности, не по скорингу: отвечаем на средние и крупные,
      // мелочь пропускаем молча. Оценка score остаётся только справочной меткой.
      const grade = String(analysis.size_grade || 'small');
      const sizeQualified = grade === 'medium' || grade === 'large'
        || analysis.recommended_price >= Number(process.env.MIN_DEAL_PRICE_RUB || 30000);
      const shouldRespond = analysis.should_respond && sizeQualified;
      await this.progress.advance(
        'save',
        'Сохраняю оценку и решаю, подходит ли заказ',
        `${analysis.score}/100 · ${shouldRespond ? 'подходит' : 'отсеян'}`,
      );
      const storedAnalysis = {
        ...analysis,
        analyzer: {
          version: 'v3-single-pass-20260723',
          mode: analysisMode,
          fingerprint,
        },
      };
      await this.db.query(
        `UPDATE leads SET score=$2,confidence=$3,recommended_price=$4,recommended_days=$5,analysis=$6,
         status=CASE WHEN $7 THEN 'qualified' ELSE 'rejected' END,
         analysis_fingerprint=$8,analysis_state='completed',analysis_completed_at=now(),updated_at=now()
         WHERE id=$1`,
        [
          leadId,
          analysis.score,
          analysis.confidence,
          analysis.recommended_price,
          analysis.recommended_days,
          JSON.stringify(storedAnalysis),
          shouldRespond,
          fingerprint,
        ],
      );
      await this.db.query(
        "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,$2,'lead_analyzed',$3)",
        [leadId, localAnalysis ? 'system' : 'ai', JSON.stringify({ score: analysis.score, mode: analysisMode })],
      );
      if (analysis.underpriced && lead.source === 'fl') {
        // The client's named budget is far below the fair price: no auto-reply,
        // the owner decides whether to walk away or bid the honest number.
        const trap = analysis.underpriced;
        await this.push.notify(
          'Ловушка цены: заказ занижен',
          `${lead.title} · просят ${trap.named_budget.toLocaleString('ru-RU')} ₽, справедливая цена ${trap.fair_price.toLocaleString('ru-RU')} ₽ (в ${trap.ratio} раза больше)`,
          `/sales/?lead=${leadId}`,
        ).catch((error) => this.logger.warn(`Push skipped: ${error instanceof Error ? error.message : 'unknown'}`));
        this.logger.warn(
          `Underpriced order ${leadId}: named ${trap.named_budget} ₽ vs fair ${trap.fair_price} ₽ (x${trap.ratio}); held for owner`,
        );
      }
      if (shouldRespond && lead.source === 'fl') {
        // The owner decides which orders are worth a reply: scoring is cheap, drafting is not.
        // AUTO_DRAFT_FL=true restores the old behaviour of drafting every qualified lead.
        if (/^(?:1|true|on|yes)$/i.test(String(process.env.AUTO_DRAFT_FL || 'false').trim())) {
          // Ten letters a day is roughly what one person can actually read and
          // send; without a cap a scan burst drafts a hundred and the good ones
          // drown. Manual drafts from the dashboard are never counted.
          const limit = Math.max(0, Number(process.env.AUTO_DRAFT_DAILY_LIMIT || 10));
          if (await this.autoDraftBudgetLeft(limit)) {
            await this.queue.add('draft-reply', { leadId, channel: 'fl', targetExternalId: lead.external_id }, `initial-draft-${leadId}-${Date.now()}`);
          } else {
            this.logger.log(`Auto-draft daily limit reached (${limit}); skipping draft for ${leadId}`);
          }
        }
        await this.push.notify(
          'Подходящий заказ на FL.ru',
          `${lead.title} · ${analysis.score}/100 · ${analysis.recommended_price.toLocaleString('ru-RU')} ₽`,
          `/sales/?lead=${leadId}`,
        ).catch((error) => this.logger.warn(`Push skipped: ${error instanceof Error ? error.message : 'unknown'}`));
        await this.telegram.notifyOwnerQualifiedLead({
          leadId,
          title: lead.title,
          score: analysis.score,
          price: analysis.recommended_price,
          days: analysis.recommended_days,
          fitReason: analysis.fit_reason,
        }).catch((error) => this.logger.warn(
          `Telegram qualified lead notification skipped: ${error instanceof Error ? error.message : 'unknown'}`,
        ));
      }
      return { score: analysis.score, mode: analysisMode, gptCalls: localAnalysis ? 0 : 1 };
    } catch (error) {
      await this.db.query(
        "UPDATE leads SET analysis_state='failed',updated_at=now() WHERE id=$1 AND analysis_state='running'",
        [leadId],
      ).catch(() => undefined);
      throw error;
    }
  }

  // Fixed budget from the parsed project page, with the listing text as fallback.
  // Returns null when the reply must be skipped (fixed budget >20% below estimate),
  // otherwise the price to name in the reply: the fixed budget, or 0 for
  // negotiable/unknown budgets meaning «use the AI estimate».
  private fixedBudgetOverride(lead: Record<string, any>, mode: string): number | null {
    if (mode !== 'response' || !Number(lead.recommended_price)) return 0;
    const project = (lead.requirements?.project || {}) as Record<string, unknown>;
    let fixed = project.budget_kind === 'fixed' ? Number(project.budget_amount) || 0 : 0;
    if (!fixed) fixed = this.budgetFromText(String(lead.budget_text || ''));
    if (!fixed) fixed = this.statedBudgetFromDescription(String(lead.description || ''));
    if (!fixed) return 0;
    const estimate = Number(lead.recommended_price);
    if (estimate > fixed * 1.2) return null;
    return fixed;
  }

  private budgetFromText(text: string): number {
    const clean = String(text || '');
    if (/договорн/i.test(clean)) return 0;
    const match = clean.match(/(\d[\d\s]{2,12})/);
    return match ? Number(match[1].replace(/\s+/g, '')) || 0 : 0;
  }

  // Бюджет, названный прямо в описании заказа («Бюджет 4-5 млн», «бюджет: 500 000 ₽»).
  // Клиент его озвучил — занижать нельзя. Для вилки берём нижнюю границу.
  private statedBudgetFromDescription(text: string): number {
    const clean = String(text || '').toLowerCase();
    if (!clean.includes('бюджет')) return 0;
    const m = clean.match(/бюджет[^\n.]{0,30}?(\d[\d\s]*(?:[.,]\d+)?)(?:\s*[-–—]\s*(\d[\d\s]*(?:[.,]\d+)?))?\s*(млн|миллион\w*|тыс\w*|₽|руб\w*|к(?![а-яё]))?/);
    if (!m) return 0;
    const num = (s: string) => Number(String(s).replace(/\s+/g, '').replace(',', '.')) || 0;
    let value = num(m[1]);
    const unit = m[3] || '';
    if (!unit && value < 10000) return 0; // «бюджет 5» без единиц измерения — не цена, не рискуем
    if (/^(млн|миллион)/.test(unit)) value *= 1000000;
    else if (/^тыс/.test(unit) || unit === 'к') value *= 1000;
    return Math.round(value);
  }

  private async draft(
    leadId: string,
    channel: string,
    targetExternalId: string,
    requestedMode: string,
    ownerInstructions = '',
    ownerRequested = false,
    automationClass = '',
    followupId = '',
    followupTouch = 0,
    sendImmediately = false,
  ) {
    const leadResult = await this.db.query('SELECT * FROM leads WHERE id=$1', [leadId]);
    const lead = leadResult.rows[0];
    if (!lead) return;
    const initialFlResponse = channel === 'fl' && !requestedMode && !lead.client?.fl_dialog_id;
    if (initialFlResponse && lead.status !== 'qualified' && !ownerRequested) {
      this.logger.log(`Skipping initial FL draft for non-qualified lead ${leadId}`);
      return;
    }
    const mode = resolveDraftMode(channel, requestedMode, Boolean(lead.client?.fl_dialog_id));
    // Owner pricing rules for FL proposals.  If the order has a fixed budget, the
    // reply names that exact budget: never lower.  If the fixed budget sits more
    // than 20% below the AI estimate, the order pays too little — no reply at all.
    // Negotiable or unknown budget → reply with the AI estimate.
    const priceOverride = this.fixedBudgetOverride(lead, mode);
    if (priceOverride === null && !ownerRequested) {
      const fixed = Number(lead.requirements?.project?.budget_amount) || this.budgetFromText(lead.budget_text);
      await this.db.query(
        "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'system','auto_skipped_low_budget',$2)",
        [leadId, JSON.stringify({ fixed_budget: fixed, estimate: Number(lead.recommended_price) || 0 })],
      );
      await this.db.query(
        "UPDATE leads SET next_action='auto_skipped_low_budget',updated_at=now() WHERE id=$1",
        [leadId],
      );
      this.logger.log(`Draft skipped for ${leadId}: fixed budget ${fixed} is >20% below estimate ${lead.recommended_price}`);
      return;
    }
    await this.progress.retitle(mode === 'response' ? 'Готовлю отклик на заказ' : 'Готовлю ответ клиенту в чат');
    // A live mission both steers the wording ("reply in Elvish") and unlocks autonomy
    // for this one lead.  Owner instructions typed right now still win over it.
    const mission = await this.autonomy.missionRuntime(leadId);
    const missionUsable = Boolean(mission && !mission.expired && !mission.exhausted);
    const effectiveInstructions = ownerInstructions
      || (missionUsable && mission ? mission.instruction : '');
    const messages = await this.db.query(
      `SELECT * FROM (
         SELECT id,direction,author,content,created_at FROM messages
         WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 240
       ) recent ORDER BY created_at`,
      [leadId],
    );
    const agentTurn = mode === 'chat' && !effectiveInstructions
      ? await this.salesAgent.prepareTurn(leadId, channel)
      : null;
    // A draft that fails the automatic style checks is still worth showing: the owner
    // reads it, fixes a sentence or regenerates, instead of waiting minutes for nothing.
    let qualityIssues: string[] = [];
    let content = agentTurn?.reply || '';
    if (!content) {
      try {
        content = await this.ai.draftReply({
          lead,
          messages: messages.rows,
          mode,
          ownerInstructions: effectiveInstructions.slice(0, 4_000),
          priceOverride,
        });
      } catch (error) {
        if (!(error instanceof ProposalQualityError)) throw error;
        content = error.content;
        qualityIssues = error.issues;
        await this.progress.note('автопроверка нашла замечания — сохраню черновик с пометкой');
        this.logger.warn(`Draft for lead ${leadId} kept with ${qualityIssues.length} quality warnings`);
      }
    }
    const proposalReview = mode === 'response'
      ? await this.ai.proposalReviewContext(lead, content)
      : null;
    const hash = createHash('sha256').update(content).digest('hex');
    const dialogId = channel === 'fl' ? String(lead.client?.fl_dialog_id || targetExternalId || '') : '';
    const actualTarget = channel === 'fl' && mode === 'chat' ? dialogId : targetExternalId;
    const metadata = channel === 'fl'
      ? mode === 'chat'
        ? {
          mode: 'chat',
          dialogId,
          regenerated: Boolean(ownerInstructions),
          agent: agentTurn
            ? {
              stage: agentTurn.stage,
              conversationStage: agentTurn.conversation_stage,
              confidence: agentTurn.confidence,
              intent: agentTurn.intent,
              discoveryReadiness: agentTurn.discovery_readiness,
              buildReadiness: agentTurn.build_readiness,
              discoveryComplete: agentTurn.discovery_complete,
              requiresOwner: agentTurn.requires_owner,
              ownerBrief: agentTurn.owner_brief,
              replyDeadline: agentTurn.reply_deadline,
              riskFlags: agentTurn.risk_flags,
            }
            : null,
        }
        : {
          mode: 'response',
          strategy: 'proposal-research-v3-human-voice',
          projectUrl: lead.url,
          price: priceOverride || lead.recommended_price,
          days: lead.recommended_days,
          priceDisplayedSeparately: true,
          regenerated: Boolean(ownerInstructions),
          review: proposalReview
            ? {
              technology_fit: proposalReview.technologyFit,
              availability_configured: proposalReview.availabilityConfigured,
              availability: proposalReview.availability || null,
              voiceprint: proposalReview.voiceprint,
              humanity_metrics: proposalReview.deliveryMetrics,
              flags: [
                ...(proposalReview.technologyFit.risk === 'elevated' ? ['technology_fit_unverified'] : []),
                ...(!proposalReview.availabilityConfigured ? ['availability_missing'] : []),
                ...(!proposalReview.voiceprint.ready ? ['voiceprint_insufficient'] : []),
                ...(qualityIssues.length ? ['style_check_failed'] : []),
              ],
              quality_issues: qualityIssues,
            }
            : null,
        }
      : {
        mode: 'chat',
        agent: agentTurn
          ? {
            stage: agentTurn.stage,
            conversationStage: agentTurn.conversation_stage,
            confidence: agentTurn.confidence,
            intent: agentTurn.intent,
            discoveryReadiness: agentTurn.discovery_readiness,
            buildReadiness: agentTurn.build_readiness,
            discoveryComplete: agentTurn.discovery_complete,
            requiresOwner: agentTurn.requires_owner,
            ownerBrief: agentTurn.owner_brief,
            replyDeadline: agentTurn.reply_deadline,
            riskFlags: agentTurn.risk_flags,
          }
          : null,
      };
    if (automationClass) {
      Object.assign(metadata, {
        automationClass,
        ...(followupId ? { followup_schedule_id: followupId } : {}),
        ...(followupTouch ? { followup_touch: followupTouch } : {}),
      });
    }
    if (initialFlResponse && !ownerRequested) {
      const latestStatus = (await this.db.query('SELECT status FROM leads WHERE id=$1', [leadId])).rows[0]?.status;
      if (latestStatus !== 'qualified') {
        this.logger.log(`Discarding initial FL draft after lead ${leadId} was reclassified`);
        return;
      }
    }
    await this.progress.advance('save', 'Сохраняю черновик — он ждёт вашего решения');
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO drafts(lead_id,kind,channel,target_external_id,content,content_hash,source_last_message_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(channel,target_external_id,content_hash) DO NOTHING RETURNING id`,
      [leadId, messages.rows.length ? 'reply' : 'initial_response', channel, actualTarget, content, hash, lead.last_inbound_message_id, JSON.stringify(metadata)],
    );
    if (!inserted.rows[0]) return;
    const draftId = inserted.rows[0].id;
    if (mode === 'response') {
      await this.db.query(
        `UPDATE drafts SET status='rejected',
           metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('superseded_by',$2::text),updated_at=now()
         WHERE lead_id=$1 AND id<>$2 AND status IN ('pending','failed','stale')
           AND (kind='initial_response' OR metadata->>'mode'='response')`,
        [leadId, draftId],
      );
    }
    await this.db.query("INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'ai','draft_created',$2)", [leadId, JSON.stringify({ channel })]);
    if (agentTurn?.discovery_complete) {
      await this.queue.add(
        'generate-documents',
        { leadId },
        `discovery-documents-${leadId}-${String(lead.last_inbound_message_id || 'none')}`,
      );
    }

    const latestInbound = [...messages.rows].reverse().find((message) => message.direction === 'inbound');
    const sourceMessageId = String(lead.last_inbound_message_id || latestInbound?.id || '') || null;
    const [runtimeSignals, duplicate] = await Promise.all([
      this.autonomy.runtimeSignals(channel),
      ownerRequested ? Promise.resolve(false) : this.autonomy.wasSourceMessageDecided(sourceMessageId),
    ]);
    if (agentTurn?.requires_owner) runtimeSignals.push('agent_requires_owner');
    const decision = await this.autonomy.evaluate({
      inbound: String(latestInbound?.content || lead.description || ''),
      outbound: content,
      mode: mode === 'response' ? 'response' : 'chat',
      channel,
      automationClass: automationClass || undefined,
      duplicate,
      leadConfidence: typeof lead.confidence === 'number' ? lead.confidence : null,
      runtimeSignals,
      mission,
    });
    await this.autonomy.recordDecision({
      leadId,
      draftId,
      sourceMessageId,
      policyMode: decision.policyMode,
      evaluation: decision,
    });
    await this.db.query(
      `UPDATE drafts SET metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
         'autonomy',jsonb_build_object(
           'decision',$2::text,'confidence',$3::numeric,'reason',$4::text,'signals',$5::jsonb
         )
       ),updated_at=now() WHERE id=$1`,
      [draftId, decision.decision, decision.confidence, decision.reason, JSON.stringify(decision.signals)],
    );

    if (decision.decision === 'skip') {
      await this.db.query("UPDATE drafts SET status='rejected',updated_at=now() WHERE id=$1 AND status='pending'", [draftId]);
      await this.db.query(
        "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'autonomy','draft_skipped',$2)",
        [leadId, JSON.stringify({ draftId, confidence: decision.confidence, reason: decision.reason, signals: decision.signals })],
      );
      return { draftId, decision: decision.decision };
    }

    if (decision.decision === 'auto_send') {
      const approved = await this.db.query(
        `UPDATE drafts SET status='approved',approved_at=now(),
         metadata=metadata || jsonb_build_object('auto_approved',true),updated_at=now()
         WHERE id=$1 AND status='pending' RETURNING id`,
        [draftId],
      );
      if (approved.rows[0]) {
        if (decision.signals.includes('mission')) await this.autonomy.consumeMissionTurn(leadId);
        await this.db.query(
          "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'autonomy','draft_auto_approved',$2)",
          [leadId, JSON.stringify({ draftId, confidence: decision.confidence, reason: decision.reason, mission: decision.signals.includes('mission') })],
        );
        // A direct owner command such as "пиши ему сейчас" is already a timing
        // decision. Presence hours still apply to autonomous reactions, but must
        // not silently postpone this explicit opening until the next workday.
        const delayMs = sendImmediately
          ? 0
          : await this.research.autoReplyDelayMs(content.length, `${leadId}:${sourceMessageId || draftId}`);
        await this.queue.add(
          'send-draft',
          { draftId },
          `auto-send-${draftId}-${hash.slice(0, 16)}`,
          { delayMs },
        );
      }
      return { draftId, decision: decision.decision };
    }

    if (!isSandboxLead(lead)) {
      await this.push.notify('Нужен ваш ответ', `${lead.title} · ${decision.reason}`, '/sales/?page=approvals')
        .catch((error) => this.logger.warn(`Push skipped: ${error instanceof Error ? error.message : 'unknown'}`));
      await this.telegram.notifyOwnerDraft(leadId, draftId, lead.title, content)
        .catch((error) => this.logger.warn(`Telegram owner notification skipped: ${error instanceof Error ? error.message : 'unknown'}`));
    }
    return { draftId, decision: decision.decision };
  }

  private async processFollowups() {
    const due = await this.research.claimDueFollowup();
    if (!due) return { processed: 0 };
    try {
      const created = await this.draft(
        due.lead_id,
        due.channel,
        due.target_external_id || '',
        'chat',
        followupInstruction(due.touch_no),
        true,
        'followup',
        due.id,
        due.touch_no,
      );
      if (!created?.draftId) {
        await this.research.cancelFollowup(due.id, 'draft_not_created');
        return { processed: 1, drafted: 0 };
      }
      await this.research.markFollowupDrafted(due.id, created.draftId);
      await this.telegram.notifyOwnerSystem(
        `Follow-up №${due.touch_no} для «${due.title}» готов как черновик. Клиенту ничего не отправлено.`,
        '/sales/?page=approvals',
      ).catch((error) => this.logger.warn(`Follow-up owner notice skipped: ${error instanceof Error ? error.message : 'unknown'}`));
      return { processed: 1, drafted: 1 };
    } catch (error) {
      await this.research.cancelFollowup(due.id, 'draft_generation_failed');
      throw error;
    }
  }

  /**
   * One notice per fingerprint per window. The owner asked for silence, so every
   * alert path goes through here instead of firing per task or per lead.
   */
  private async alertOnce(fingerprint: string, windowMinutes: number, message: string): Promise<boolean> {
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO activities(actor,action,details)
       SELECT 'watchdog','health_alert',$1::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM activities WHERE action='health_alert'
           AND details->>'fingerprint'=$2 AND created_at>=now()-($3::int * interval '1 minute')
       ) RETURNING id`,
      [JSON.stringify({ fingerprint, message }), fingerprint, windowMinutes],
    );
    if (!inserted.rows[0]) return false;
    await this.push.notify('Freelance Sales требует внимания', message, '/sales/?page=settings')
      .catch((error) => this.logger.warn(`Watchdog push skipped: ${error instanceof Error ? error.message : 'unknown'}`));
    await this.telegram.notifyOwnerSystem(message, '/sales/?page=settings')
      .catch((error) => this.logger.warn(`Watchdog Telegram notice skipped: ${error instanceof Error ? error.message : 'unknown'}`));
    return true;
  }

  private async healthWatchdog() {
    const failed = await this.db.query<{ id: string; kind: string }>(
      `UPDATE ai_tasks SET status='failed',error='AI worker heartbeat timeout; automatic replay disabled',
       completed_at=now(),duration_ms=GREATEST(0,extract(epoch FROM (now()-created_at))*1000)::int,updated_at=now()
       WHERE status='claimed' AND claimed_at<now()-interval '25 minutes'
       RETURNING id,kind`,
    );
    if (failed.rows.length) {
      const message = `${failed.rows.length} AI-задач остановлено watchdog: автоповтор отключён, нужна проверка.`;
      await this.push.notify('Freelance Sales требует внимания', message, '/sales/?page=settings')
        .catch((error) => this.logger.warn(`Watchdog push skipped: ${error instanceof Error ? error.message : 'unknown'}`));
      await this.telegram.notifyOwnerSystem(message, '/sales/?page=settings')
        .catch((error) => this.logger.warn(`Watchdog Telegram notice skipped: ${error instanceof Error ? error.message : 'unknown'}`));
    }
    const unhealthy = await this.db.query<{ connector: string; status_text: string | null }>(
      `SELECT connector,status_text FROM connector_state
       WHERE NOT healthy ORDER BY connector`,
    );
    let connectorAlerts = 0;
    for (const connector of unhealthy.rows) {
      const fingerprint = createHash('sha256')
        .update(`${connector.connector}:${connector.status_text || 'unhealthy'}`)
        .digest('hex');
      const inserted = await this.db.query(
        `INSERT INTO activities(actor,action,details)
         SELECT 'watchdog','connector_health_alert',$1
         WHERE NOT EXISTS (
           SELECT 1 FROM activities WHERE action='connector_health_alert'
             AND details->>'fingerprint'=$2 AND created_at>=now()-interval '1 hour'
         ) RETURNING id`,
        [JSON.stringify({ connector: connector.connector, status: connector.status_text, fingerprint }), fingerprint],
      );
      if (!inserted.rows[0]) continue;
      connectorAlerts += 1;
      const message = `Коннектор ${connector.connector} требует внимания: ${String(connector.status_text || 'нет подтверждения здоровья').slice(0, 240)}`;
      await this.push.notify('Freelance Sales: коннектор недоступен', message, '/sales/?page=settings')
        .catch((error) => this.logger.warn(`Connector push skipped: ${error instanceof Error ? error.message : 'unknown'}`));
      await this.telegram.notifyOwnerSystem(message, '/sales/?page=settings')
        .catch((error) => this.logger.warn(`Connector Telegram notice skipped: ${error instanceof Error ? error.message : 'unknown'}`));
    }
    // A broker outage shows up as a wave of timed-out tasks, not as stuck 'claimed'
    // rows, so the stuck-task sweep above stays silent. One notice per hour is enough:
    // the owner can act, and a per-task notice would be a flood (1709 failures on 2026-09-14).
    const aiHealth = await this.db.query<{ failed: string; completed: string }>(
      `SELECT count(*) FILTER (WHERE status='failed')::text AS failed,
              count(*) FILTER (WHERE status='completed')::text AS completed
         FROM ai_tasks WHERE created_at>=now()-interval '30 minutes'`,
    );
    const failedAi = Number(aiHealth.rows[0]?.failed || 0);
    const completedAi = Number(aiHealth.rows[0]?.completed || 0);
    if (failedAi >= 8 && failedAi > completedAi) {
      await this.alertOnce(
        'ai_broker_outage',
        60,
        `Нейросеть не отвечает: за 30 минут ${failedAi} задач упало, удачных ${completedAi}. Заказы копились в базе, часть анализа пропущена.`,
      );
    }
    // Leads that never reached analysis: no activity row at all means the pipeline
    // dropped them. Old ones stay old, so the window is deliberately long.
    const stuckLeads = await this.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM leads l
        WHERE l.status='new' AND l.created_at<=now()-interval '3 hours'
          AND l.created_at>=now()-interval '24 hours'
          AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.lead_id=l.id)`,
    );
    const stuckCount = Number(stuckLeads.rows[0]?.total || 0);
    if (stuckCount >= 10) {
      await this.alertOnce(
        'leads_stuck',
        360,
        `${stuckCount} заказов висят без движения дольше трёх часов: анализ до них не дошёл.`,
      );
    }
    return { failed: failed.rows.length, connectorAlerts };
  }

  private async generateDocuments(leadId: string) {
    const lead = (await this.db.query('SELECT * FROM leads WHERE id=$1', [leadId])).rows[0];
    if (!lead) return;
    const messages = (await this.db.query('SELECT direction,author,content,created_at FROM messages WHERE lead_id=$1 ORDER BY created_at', [leadId])).rows;
    const agentState = await this.salesAgent.state(leadId);
    const context = { lead, messages, agent: agentState };
    const [markdown, contractData, codexHandoff] = await Promise.all([
      this.ai.generateSpecification(context),
      this.ai.generateContractData(context),
      this.salesAgent.buildCodexHandoff(leadId),
    ]);
    await this.progress.advance('save', 'Сохраняю документы');
    const versionResult = await this.db.query<{ version: number }>('SELECT COALESCE(max(version),0)+1 AS version FROM documents WHERE lead_id=$1 AND kind=$2', [leadId, 'specification']);
    const version = Number(versionResult.rows[0].version);
    const path = await this.docs.writeDocx(leadId, 'specification', version, markdown);
    const hasContractTemplate = await this.docs.hasContractTemplate();
    const contractPath = hasContractTemplate ? await this.docs.writeContract(leadId, version, contractData) : null;
    await this.db.transaction(async (client) => {
      await client.query('INSERT INTO documents(lead_id,kind,version,markdown,file_path,metadata) VALUES($1,$2,$3,$4,$5,$6)', [leadId, 'specification', version, markdown, path, JSON.stringify({ completeness: markdown.includes('OPEN_QUESTION') ? 'needs_answers' : 'ready' })]);
      await client.query('INSERT INTO documents(lead_id,kind,version,markdown,metadata) VALUES($1,$2,$3,$4,$5)', [leadId, 'contract_data', version, JSON.stringify(contractData, null, 2), JSON.stringify({ template_required: !hasContractTemplate })]);
      await client.query(
        'INSERT INTO documents(lead_id,kind,version,markdown,metadata) VALUES($1,$2,$3,$4,$5)',
        [
          leadId,
          'codex_handoff',
          version,
          JSON.stringify(codexHandoff.payload, null, 2),
          JSON.stringify({
            handoffId: codexHandoff.id,
            status: codexHandoff.status,
            openQuestions: Array.isArray(codexHandoff.payload.open_questions)
              ? codexHandoff.payload.open_questions.length
              : 0,
          }),
        ],
      );
      if (contractPath) {
        await client.query('INSERT INTO documents(lead_id,kind,version,markdown,file_path,metadata) VALUES($1,$2,$3,$4,$5,$6)', [leadId, 'contract', version, '', contractPath, JSON.stringify({ review_required: true, open_questions: contractData.open_questions || [] })]);
      }
      await client.query("INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'ai','documents_generated',$2)", [leadId, JSON.stringify({ version })]);
    });
    return { version };
  }

  private async sendDraft(draftId: string) {
    const draft = await this.db.transaction(async (client) => {
      const result = await client.query('SELECT d.*,l.title AS lead_title,l.source AS lead_source,l.client AS lead_client,l.last_inbound_message_id,l.url,l.recommended_price,l.recommended_days FROM drafts d JOIN leads l ON l.id=d.lead_id WHERE d.id=$1 FOR UPDATE', [draftId]);
      const row = result.rows[0];
      if (!row) throw new Error('Черновик не найден');
      if (row.status !== 'approved') return null;
      const actualHash = createHash('sha256').update(row.content).digest('hex');
      if (actualHash !== row.content_hash) {
        const error = 'Текст изменён после одобрения';
        await client.query("UPDATE drafts SET status='failed',error=$2,updated_at=now() WHERE id=$1", [draftId, error]);
        return { beforeSendFailure: true, lead_title: row.lead_title, channel: row.channel, error };
      }
      const mediaAssetIds = Array.isArray(row.metadata?.mediaAssetIds)
        ? row.metadata.mediaAssetIds.map(String).slice(0, 10)
        : [];
      if (mediaAssetIds.length) {
        const actualMediaHash = createHash('sha256').update(JSON.stringify(mediaAssetIds)).digest('hex');
        if (actualMediaHash !== row.metadata?.mediaHash) {
          const error = 'Состав изображений изменён после одобрения';
          await client.query("UPDATE drafts SET status='failed',error=$2,updated_at=now() WHERE id=$1", [draftId, error]);
          return { beforeSendFailure: true, lead_title: row.lead_title, channel: row.channel, error };
        }
      }
      if ((row.source_last_message_id || null) !== (row.last_inbound_message_id || null)) {
        await client.query("UPDATE drafts SET status='stale',updated_at=now() WHERE id=$1", [draftId]);
        return {
          beforeSendFailure: true,
          lead_title: row.lead_title,
          channel: row.channel,
          error: 'Клиент прислал новое сообщение до отправки; старый черновик отменён',
        };
      }
      const idempotencyKey = createHash('sha256').update(JSON.stringify([
        'outbound-v1',
        row.id,
        row.version,
        row.channel,
        row.target_external_id,
        row.content_hash,
        row.source_last_message_id || null,
      ])).digest('hex');
      const reserved = await client.query<{ id: string }>(
        `INSERT INTO outbound_deliveries(
           idempotency_key,draft_id,lead_id,channel,target_external_id,content_hash,
           status,attempt_count,attempted_at
         ) VALUES($1,$2,$3,$4,$5,$6,'sending',1,now())
         ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
        [idempotencyKey, row.id, row.lead_id, row.channel, row.target_external_id, row.content_hash],
      );
      if (!reserved.rows[0]) {
        const existing = await client.query<{ id: string; status: string; error: string | null }>(
          'SELECT id,status,error FROM outbound_deliveries WHERE idempotency_key=$1 FOR UPDATE',
          [idempotencyKey],
        );
        const status = existing.rows[0]?.status;
        if (status === 'blocked_paused' || status === 'failed_before_send') {
          await client.query(
            `UPDATE outbound_deliveries SET status='sending',error=NULL,
             attempt_count=attempt_count+1,attempted_at=now(),completed_at=NULL,updated_at=now()
             WHERE id=$1`,
            [existing.rows[0].id],
          );
          await client.query("UPDATE drafts SET status='sending',error=NULL,updated_at=now() WHERE id=$1", [draftId]);
          return { ...row, deliveryId: existing.rows[0].id, idempotencyKey };
        }
        if (status === 'sent') await client.query("UPDATE drafts SET status='sent',updated_at=now() WHERE id=$1", [draftId]);
        if (status === 'send_unknown') {
          await client.query("UPDATE drafts SET status='send_unknown',error=$2,updated_at=now() WHERE id=$1", [draftId, existing.rows[0]?.error || 'Статус отправки неизвестен']);
        }
        return null;
      }
      await client.query("UPDATE drafts SET status='sending',error=NULL,updated_at=now() WHERE id=$1", [draftId]);
      return { ...row, deliveryId: reserved.rows[0].id, idempotencyKey };
    });
    if (!draft) return;
    if (draft.beforeSendFailure) {
      if (!isSandboxLead({ source: draft.lead_source, client: draft.lead_client })) {
        await this.telegram.notifyOwnerDeliveryResult({
          status: 'failed',
          leadTitle: draft.lead_title,
          channel: draft.channel,
          error: draft.error,
        }).catch((error) => this.logger.warn(
          `Telegram delivery result notification skipped: ${error instanceof Error ? error.message : 'unknown'}`,
        ));
      }
      return { failed: true, deliveryUnknown: false, error: draft.error };
    }

    if (isSandboxLead({ source: draft.lead_source, client: draft.lead_client })) {
      const externalId = `sandbox:${draft.deliveryId}`;
      await this.db.transaction(async (client) => {
        await client.query(
          `UPDATE outbound_deliveries SET status='sent',external_id=$2,error='[sandbox] external write blocked',
           completed_at=now(),updated_at=now() WHERE id=$1 AND status='sending'`,
          [draft.deliveryId, externalId],
        );
        await client.query("UPDATE drafts SET status='sent',sent_at=now(),updated_at=now() WHERE id=$1", [draftId]);
        await client.query(
          `INSERT INTO messages(lead_id,channel,external_id,direction,author,content,metadata)
           VALUES($1,$2,$3,'outbound','owner',$4,$5) ON CONFLICT(channel,external_id) DO NOTHING`,
          [draft.lead_id, draft.channel, externalId, draft.content, JSON.stringify({ draft_id: draftId, sandbox: true })],
        );
        await client.query(
          "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'sandbox','sandbox_delivery_captured',$2)",
          [draft.lead_id, JSON.stringify({ draftId, channel: draft.channel, externalWriteBlocked: true })],
        );
      });
      return { sent: true, sandbox: true };
    }

    // Deliberately kept next to the external write.  A pause is durable and is
    // checked again after the operation has acquired its idempotency slot.
    const pause = await this.autonomy.outboundPause(draft.lead_id);
    if (pause.paused) {
      await this.db.transaction(async (client) => {
        await client.query(
          `UPDATE outbound_deliveries SET status='blocked_paused',error=$2,completed_at=now(),updated_at=now()
           WHERE id=$1 AND status='sending'`,
          [draft.deliveryId, pause.reason],
        );
        await client.query(
          `UPDATE drafts SET status='pending',approved_by=NULL,approved_at=NULL,error=$2,
           metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('pause_scope',$3::text),updated_at=now()
           WHERE id=$1`,
          [draftId, pause.reason, pause.scope],
        );
        await client.query(
          "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'autonomy','outbound_blocked_paused',$2)",
          [draft.lead_id, JSON.stringify({ draftId, scope: pause.scope, reason: pause.reason })],
        );
      });
      await this.telegram.notifyOwnerDeliveryResult({
        status: 'blocked',
        leadTitle: draft.lead_title,
        channel: draft.channel,
        error: pause.reason,
      }).catch((error) => this.logger.warn(
        `Telegram delivery result notification skipped: ${error instanceof Error ? error.message : 'unknown'}`,
      ));
      return { blocked: true, reason: pause.reason };
    }

    try {
      await this.progress.advance(
        'send',
        'Отправляю в канал клиента',
        draft.channel === 'telegram' ? 'Telegram' : 'FL.ru',
      );
      let externalId: string | null = null;
      if (draft.channel === 'telegram') {
        const mediaAssetIds = Array.isArray(draft.metadata?.mediaAssetIds)
          ? draft.metadata.mediaAssetIds.map(String).slice(0, 10)
          : [];
        externalId = mediaAssetIds.length
          ? (await this.telegram.sendBusinessMediaGroup(
              draft.target_external_id,
              draft.content,
              await this.design.urls(mediaAssetIds),
            )).externalId
          : (await this.telegram.sendBusinessMessage(draft.target_external_id, draft.content)).externalId;
      } else if (draft.channel === 'fl') {
        if (draft.kind !== 'initial_response' && draft.metadata?.mode !== 'response') {
          await this.fl.sendChatMessage(String(draft.metadata.dialogId || draft.target_external_id), draft.content);
        } else {
          await this.fl.sendResponse({ projectUrl: draft.url, content: draft.content, price: draft.recommended_price, days: draft.recommended_days });
        }
      } else {
        throw new Error(`Канал ${draft.channel} не поддерживается`);
      }
      await this.progress.advance('confirm', 'Записываю результат в журнал доставок', 'отправлено');
      await this.db.transaction(async (client) => {
        await client.query(
          `UPDATE outbound_deliveries SET status='sent',external_id=$2,completed_at=now(),updated_at=now()
           WHERE id=$1 AND status='sending'`,
          [draft.deliveryId, externalId],
        );
        await client.query("UPDATE drafts SET status='sent',sent_at=now(),updated_at=now() WHERE id=$1", [draftId]);
        await client.query('INSERT INTO messages(lead_id,channel,external_id,direction,author,content,metadata) VALUES($1,$2,$3,\'outbound\',\'owner\',$4,$5) ON CONFLICT(channel,external_id) DO NOTHING', [draft.lead_id, draft.channel, externalId, draft.content, JSON.stringify({ draft_id: draftId })]);
        await client.query("UPDATE followup_schedule SET status='sent',updated_at=now() WHERE draft_id=$1", [draftId]);
        await client.query("INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'system','draft_sent',$2)", [draft.lead_id, JSON.stringify({ draftId, channel: draft.channel, idempotencyKey: draft.idempotencyKey })]);
      });
      await this.telegram.notifyOwnerDeliveryResult({
        status: 'sent',
        leadTitle: draft.lead_title,
        channel: draft.channel,
      }).catch((error) => this.logger.warn(
        `Telegram delivery result notification skipped: ${error instanceof Error ? error.message : 'unknown'}`,
      ));
      await this.research.scheduleAfterOutbound(draftId)
        .catch((error) => this.logger.warn(`Follow-up schedule skipped: ${error instanceof Error ? error.message : 'unknown'}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
      const messageWithStack = error instanceof Error && error.stack ? (message + ' || ' + error.stack.split('\n').slice(0, 4).join(' | ')) : message;
      const deliveryUnknown = isDeliveryUnknown(error);
      const needsOwner = error instanceof OutboundPreflightError;
      const ledgerStatus = deliveryUnknown ? 'send_unknown' : 'failed_before_send';
      const draftStatus = deliveryUnknown ? 'send_unknown' : needsOwner ? 'pending' : 'failed';
      await this.db.transaction(async (client) => {
        await client.query(
          `UPDATE outbound_deliveries SET status=$2,error=$3,completed_at=now(),updated_at=now()
           WHERE id=$1 AND status='sending'`,
          [draft.deliveryId, ledgerStatus, messageWithStack.slice(0, 500)],
        );
        await client.query(
          `UPDATE drafts SET status=$2,error=$3,
           approved_by=CASE WHEN $2='pending' THEN NULL ELSE approved_by END,
           approved_at=CASE WHEN $2='pending' THEN NULL ELSE approved_at END,
           updated_at=now() WHERE id=$1`,
          [draftId, draftStatus, messageWithStack.slice(0, 500)],
        );
        if (needsOwner) {
          await client.query(
            `UPDATE autonomy_decisions SET decision='ask_owner',confidence=1,reason=$2,
             signals=signals || $3::jsonb WHERE draft_id=$1`,
            [draftId, message.slice(0, 500), JSON.stringify([(error as OutboundPreflightError).code])],
          );
        }
        await client.query(
          "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'system',$2,$3)",
          [
            draft.lead_id,
            deliveryUnknown ? 'outbound_send_unknown' : 'outbound_failed_before_send',
            JSON.stringify({ draftId, channel: draft.channel, error: message.slice(0, 500), idempotencyKey: draft.idempotencyKey }),
          ],
        );
      });
      if (deliveryUnknown) {
        await this.push.notify(
          'Проверьте отправку вручную',
          'Сервис не может доказать, доставлено ли сообщение. Автоповтор отключён.',
          `/sales/?lead=${draft.lead_id}`,
        ).catch((pushError) => this.logger.warn(`Push skipped: ${pushError instanceof Error ? pushError.message : 'unknown'}`));
      } else if (needsOwner) {
        await this.push.notify('Нужна проверка FL.ru', message, '/sales/?page=approvals')
          .catch((pushError) => this.logger.warn(`Push skipped: ${pushError instanceof Error ? pushError.message : 'unknown'}`));
      }
      await this.telegram.notifyOwnerDeliveryResult({
        status: deliveryUnknown ? 'send_unknown' : 'failed',
        leadTitle: draft.lead_title,
        channel: draft.channel,
        error: message,
      }).catch((notifyError) => this.logger.warn(
        `Telegram delivery result notification skipped: ${notifyError instanceof Error ? notifyError.message : 'unknown'}`,
      ));
      return { failed: true, deliveryUnknown, error: message };
    }
    return { sent: true };
  }

  async onModuleDestroy() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.portfolioTimer) clearInterval(this.portfolioTimer);
    if (this.announceTimer) clearInterval(this.announceTimer);
    if (this.researchTimer) clearInterval(this.researchTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.worker?.close();
    await this.connection?.quit();
  }
}
