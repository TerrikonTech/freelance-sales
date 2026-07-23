import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { createHash } from 'node:crypto';
import { AiService } from './ai.service';
import { DatabaseService } from './database.service';
import { DocumentsService } from './documents.service';
import { FlService } from './fl.service';
import { QueueService } from './queue.service';
import { PushService } from './push.service';
import { TelegramService } from './telegram.service';

@Injectable()
export class ProcessorService implements OnModuleDestroy {
  private readonly logger = new Logger(ProcessorService.name);
  private worker?: Worker;
  private timer?: NodeJS.Timeout;
  private connection?: IORedis;

  constructor(
    private readonly db: DatabaseService,
    private readonly ai: AiService,
    private readonly docs: DocumentsService,
    private readonly fl: FlService,
    private readonly telegram: TelegramService,
    private readonly queue: QueueService,
    private readonly push: PushService,
  ) {}

  async start() {
    this.connection = new IORedis(process.env.REDIS_URL || 'redis://redis:6379', { maxRetriesPerRequest: null });
    this.worker = new Worker('sales', (job) => this.process(job), {
      connection: this.connection,
      concurrency: 3,
      lockDuration: 25 * 60_000,
      stalledInterval: 60_000,
      maxStalledCount: 1,
    });
    this.worker.on('failed', (job, error) => this.logger.error(`Job ${job?.name || 'unknown'} failed: ${error.message}`));
    const interval = Math.max(60, Number(process.env.FL_SCAN_INTERVAL_SECONDS || 120)) * 1_000;
    const schedule = async () => {
      const bucket = Math.floor(Date.now() / interval);
      await Promise.all([
        this.queue.add('scan-fl', {}, `scan-${bucket}`),
        this.queue.add('sync-fl-chats', {}, `sync-fl-chats-${bucket}`),
      ]).catch((error) => this.logger.warn(error.message));
    };
    this.timer = setInterval(schedule, interval);
    await schedule();
    this.logger.log('Worker started');
  }

  async process(job: Job) {
    switch (job.name) {
      case 'scan-fl': return this.fl.scan();
      case 'sync-fl-chats': return this.fl.syncChats();
      case 'analyze-lead': return this.analyze(String(job.data.leadId), Boolean(job.data.force));
      case 'draft-reply': return this.draft(String(job.data.leadId), String(job.data.channel || 'fl'), String(job.data.targetExternalId || ''), String(job.data.mode || ''), String(job.data.ownerInstructions || ''));
      case 'generate-documents': return this.generateDocuments(String(job.data.leadId));
      case 'send-draft': return this.sendDraft(String(job.data.draftId));
      default: throw new Error(`Unknown job ${job.name}`);
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
      const shouldRespond = analysis.should_respond && analysis.score >= Number(process.env.MIN_LEAD_SCORE || 65);
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
      if (shouldRespond && lead.source === 'fl') {
        await this.queue.add('draft-reply', { leadId, channel: 'fl', targetExternalId: lead.external_id }, `initial-draft-${leadId}-${Date.now()}`);
        await this.push.notify(
          'Подходящий заказ на FL.ru',
          `${lead.title} · ${analysis.score}/100 · ${analysis.recommended_price.toLocaleString('ru-RU')} ₽`,
          `/sales/?lead=${leadId}`,
        ).catch((error) => this.logger.warn(`Push skipped: ${error instanceof Error ? error.message : 'unknown'}`));
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

  private async draft(leadId: string, channel: string, targetExternalId: string, requestedMode: string, ownerInstructions = '') {
    const leadResult = await this.db.query('SELECT * FROM leads WHERE id=$1', [leadId]);
    const lead = leadResult.rows[0];
    if (!lead) return;
    const initialFlResponse = channel === 'fl' && !requestedMode && !lead.client?.fl_dialog_id;
    if (initialFlResponse && lead.status !== 'qualified') {
      this.logger.log(`Skipping initial FL draft for non-qualified lead ${leadId}`);
      return;
    }
    const messages = await this.db.query(
      'SELECT direction,author,content,created_at FROM messages WHERE lead_id=$1 ORDER BY created_at ASC LIMIT 100',
      [leadId],
    );
    const mode = requestedMode || (lead.client?.fl_dialog_id ? 'chat' : 'response');
    const content = await this.ai.draftReply({ lead, messages: messages.rows, mode, ownerInstructions: ownerInstructions.slice(0, 4_000) });
    const hash = createHash('sha256').update(content).digest('hex');
    const dialogId = channel === 'fl' ? String(lead.client?.fl_dialog_id || targetExternalId || '') : '';
    const actualTarget = channel === 'fl' && mode === 'chat' ? dialogId : targetExternalId;
    const metadata = channel === 'fl'
      ? mode === 'chat'
        ? { mode: 'chat', dialogId, regenerated: Boolean(ownerInstructions) }
        : { mode: 'response', strategy: 'buyer-dialogue-v4', projectUrl: lead.url, price: lead.recommended_price, days: lead.recommended_days, priceDisplayedSeparately: true, regenerated: Boolean(ownerInstructions) }
      : {};
    if (initialFlResponse) {
      const latestStatus = (await this.db.query('SELECT status FROM leads WHERE id=$1', [leadId])).rows[0]?.status;
      if (latestStatus !== 'qualified') {
        this.logger.log(`Discarding initial FL draft after lead ${leadId} was reclassified`);
        return;
      }
    }
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO drafts(lead_id,kind,channel,target_external_id,content,content_hash,source_last_message_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(channel,target_external_id,content_hash) DO NOTHING RETURNING id`,
      [leadId, messages.rows.length ? 'reply' : 'initial_response', channel, actualTarget, content, hash, lead.last_inbound_message_id, JSON.stringify(metadata)],
    );
    if (!inserted.rows[0]) return;
    if (mode === 'response') {
      await this.db.query(
        `UPDATE drafts SET status='rejected',
           metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('superseded_by',$2::text),updated_at=now()
         WHERE lead_id=$1 AND id<>$2 AND status IN ('pending','failed','stale')
           AND (kind='initial_response' OR metadata->>'mode'='response')`,
        [leadId, inserted.rows[0].id],
      );
    }
    await this.db.query("INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'ai','draft_created',$2)", [leadId, JSON.stringify({ channel })]);
    await this.push.notify('Черновик готов', `${lead.title} · требуется ваше одобрение`, '/sales/?page=approvals')
      .catch((error) => this.logger.warn(`Push skipped: ${error instanceof Error ? error.message : 'unknown'}`));
  }

  private async generateDocuments(leadId: string) {
    const lead = (await this.db.query('SELECT * FROM leads WHERE id=$1', [leadId])).rows[0];
    if (!lead) return;
    const messages = (await this.db.query('SELECT direction,author,content,created_at FROM messages WHERE lead_id=$1 ORDER BY created_at', [leadId])).rows;
    const context = { lead, messages };
    const markdown = await this.ai.generateSpecification(context);
    const contractData = await this.ai.generateContractData(context);
    const versionResult = await this.db.query<{ version: number }>('SELECT COALESCE(max(version),0)+1 AS version FROM documents WHERE lead_id=$1 AND kind=$2', [leadId, 'specification']);
    const version = Number(versionResult.rows[0].version);
    const path = await this.docs.writeDocx(leadId, 'specification', version, markdown);
    const hasContractTemplate = await this.docs.hasContractTemplate();
    const contractPath = hasContractTemplate ? await this.docs.writeContract(leadId, version, contractData) : null;
    await this.db.transaction(async (client) => {
      await client.query('INSERT INTO documents(lead_id,kind,version,markdown,file_path,metadata) VALUES($1,$2,$3,$4,$5,$6)', [leadId, 'specification', version, markdown, path, JSON.stringify({ completeness: markdown.includes('OPEN_QUESTION') ? 'needs_answers' : 'ready' })]);
      await client.query('INSERT INTO documents(lead_id,kind,version,markdown,metadata) VALUES($1,$2,$3,$4,$5)', [leadId, 'contract_data', version, JSON.stringify(contractData, null, 2), JSON.stringify({ template_required: !hasContractTemplate })]);
      if (contractPath) {
        await client.query('INSERT INTO documents(lead_id,kind,version,markdown,file_path,metadata) VALUES($1,$2,$3,$4,$5,$6)', [leadId, 'contract', version, '', contractPath, JSON.stringify({ review_required: true, open_questions: contractData.open_questions || [] })]);
      }
      await client.query("INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'ai','documents_generated',$2)", [leadId, JSON.stringify({ version })]);
    });
    return { version };
  }

  private async sendDraft(draftId: string) {
    const draft = await this.db.transaction(async (client) => {
      const result = await client.query('SELECT d.*,l.last_inbound_message_id,l.url,l.recommended_price,l.recommended_days FROM drafts d JOIN leads l ON l.id=d.lead_id WHERE d.id=$1 FOR UPDATE', [draftId]);
      const row = result.rows[0];
      if (!row) throw new Error('Черновик не найден');
      if (row.status !== 'approved') return null;
      const actualHash = createHash('sha256').update(row.content).digest('hex');
      if (actualHash !== row.content_hash) throw new Error('Текст изменён после одобрения');
      if ((row.source_last_message_id || null) !== (row.last_inbound_message_id || null)) {
        await client.query("UPDATE drafts SET status='stale',updated_at=now() WHERE id=$1", [draftId]);
        return null;
      }
      await client.query("UPDATE drafts SET status='sending',updated_at=now() WHERE id=$1", [draftId]);
      return row;
    });
    if (!draft) return;
    try {
      let externalId: string | null = null;
      if (draft.channel === 'telegram') {
        externalId = (await this.telegram.sendBusinessMessage(draft.target_external_id, draft.content)).externalId;
      } else if (draft.channel === 'fl') {
        if (draft.metadata?.mode === 'chat') {
          await this.fl.sendChatMessage(String(draft.metadata.dialogId || draft.target_external_id), draft.content);
        } else {
          await this.fl.sendResponse({ projectUrl: draft.url, content: draft.content, price: draft.recommended_price, days: draft.recommended_days });
        }
      } else {
        throw new Error(`Канал ${draft.channel} не поддерживается`);
      }
      await this.db.transaction(async (client) => {
        await client.query("UPDATE drafts SET status='sent',sent_at=now(),updated_at=now() WHERE id=$1", [draftId]);
        await client.query('INSERT INTO messages(lead_id,channel,external_id,direction,author,content,metadata) VALUES($1,$2,$3,\'outbound\',\'owner\',$4,$5) ON CONFLICT(channel,external_id) DO NOTHING', [draft.lead_id, draft.channel, externalId, draft.content, JSON.stringify({ draft_id: draftId })]);
        await client.query("INSERT INTO activities(lead_id,actor,action,details) VALUES($1,'system','draft_sent',$2)", [draft.lead_id, JSON.stringify({ draftId, channel: draft.channel })]);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
      await this.db.query("UPDATE drafts SET status='failed',error=$2,updated_at=now() WHERE id=$1", [draftId, message.slice(0, 500)]);
      throw error;
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close();
    await this.connection?.quit();
  }
}
