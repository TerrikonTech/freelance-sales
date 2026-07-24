import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post, Req, Res, UnauthorizedException, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { AiService } from './ai.service';
import { AuthGuard, AuthenticatedRequest } from './auth.guard';
import { DatabaseService } from './database.service';
import { DocumentsService } from './documents.service';
import { FlService } from './fl.service';
import { QueueService } from './queue.service';
import { SalesAgentService } from './sales-agent.service';
import { SettingsService } from './settings.service';
import { TelegramService } from './telegram.service';

@Controller('api')
export class AppController {
  constructor(
    private readonly db: DatabaseService,
    private readonly queue: QueueService,
    private readonly settings: SettingsService,
    private readonly ai: AiService,
    private readonly fl: FlService,
    private readonly telegram: TelegramService,
    private readonly documents: DocumentsService,
    private readonly salesAgent: SalesAgentService,
  ) {}

  @Get('health')
  async health() {
    await this.db.query('SELECT 1');
    return { ok: true, service: 'freelance-sales-v2', strictApproval: process.env.STRICT_APPROVAL !== 'false' };
  }

  @Get('dashboard')
  @UseGuards(AuthGuard)
  async dashboard() {
    const [counts, recent, connectors, scan] = await Promise.all([
      this.db.query<{ leads: string; new24: string; analyzed24: string; qualified24: string; pending: string; qualified: string; rejected: string; active: string }>(`SELECT
        count(*)::text AS leads,
        count(*) FILTER (WHERE created_at >= now()-interval '24 hours')::text AS new24,
        count(*) FILTER (WHERE score IS NOT NULL AND created_at >= now()-interval '24 hours')::text AS analyzed24,
        count(*) FILTER (WHERE status='qualified' AND created_at >= now()-interval '24 hours')::text AS qualified24,
        count(*) FILTER (WHERE status='qualified')::text AS qualified,
        count(*) FILTER (WHERE status='rejected')::text AS rejected,
        count(*) FILTER (WHERE status IN ('contacted','discovery','proposal','negotiation'))::text AS active,
        (SELECT count(*) FROM drafts WHERE status='pending')::text AS pending FROM leads WHERE status<>'archived'`),
      this.db.query(`SELECT id,title,source,status,score,recommended_price,updated_at FROM leads
        WHERE status<>'archived' ORDER BY CASE status WHEN 'qualified' THEN 0 WHEN 'new' THEN 1 ELSE 2 END,updated_at DESC LIMIT 10`),
      this.settings.connectorSummary(),
      this.db.query(`SELECT
        COALESCE(sum(found_count),0)::text AS found24,
        COALESCE(sum(new_count),0)::text AS new24,
        COALESCE(sum(analyzed_count),0)::text AS analyzed24,
        COALESCE(sum(skipped_known_count),0)::text AS skipped24,
        COALESCE(round(avg(duration_ms)),0)::text AS avg_duration_ms,
        max(created_at) AS last_scan_at
        FROM scan_runs WHERE connector='fl' AND created_at >= now()-interval '24 hours'`),
    ]);
    return { metrics: counts.rows[0], recent: recent.rows, connectors, scan: scan.rows[0] };
  }

  @Get('leads')
  @UseGuards(AuthGuard)
  async leads() {
    return (await this.db.query("SELECT id,title,source,status,score,confidence,recommended_price,recommended_days,budget_text,url,updated_at FROM leads WHERE status<>'archived' ORDER BY updated_at DESC LIMIT 300")).rows;
  }

  @Get('chats')
  @UseGuards(AuthGuard)
  async chats() {
    return (await this.db.query(`SELECT l.id,l.title,l.source,l.status,l.updated_at,
      l.client->>'fl_dialog_id' AS fl_dialog_id,
      last_message.content AS last_message,last_message.direction AS last_direction,
      last_message.created_at AS last_message_at,
      (SELECT count(*)::int FROM messages m WHERE m.lead_id=l.id) AS message_count,
      (SELECT count(*)::int FROM drafts d WHERE d.lead_id=l.id AND d.status='pending') AS pending_drafts
      FROM leads l
      LEFT JOIN LATERAL (
        SELECT content,direction,created_at FROM messages WHERE lead_id=l.id ORDER BY created_at DESC LIMIT 1
      ) last_message ON true
      WHERE l.client ? 'fl_dialog_id' OR EXISTS (SELECT 1 FROM messages m WHERE m.lead_id=l.id)
      ORDER BY COALESCE(NULLIF(l.client->>'fl_chat_rank','')::int,999999),last_message.created_at DESC NULLS LAST,l.updated_at DESC LIMIT 300`)).rows;
  }

  @Post('leads')
  @UseGuards(AuthGuard)
  async createLead(@Body() body: { title?: string; description?: string; budgetText?: string; url?: string }) {
    if (!body.title?.trim()) throw new ConflictException('Нужно название');
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO leads(source,title,description,budget_text,url) VALUES('manual',$1,$2,$3,$4) RETURNING id`,
      [body.title.trim(), body.description || '', body.budgetText || null, body.url || null],
    );
    await this.queue.add('analyze-lead', { leadId: result.rows[0].id }, `manual-analyze-${result.rows[0].id}`);
    return result.rows[0];
  }

  @Get('leads/:id')
  @UseGuards(AuthGuard)
  async lead(@Param('id') id: string) {
    const lead = (await this.db.query('SELECT * FROM leads WHERE id=$1', [id])).rows[0];
    if (!lead) throw new NotFoundException();
    const [messages, drafts, documents, activities] = await Promise.all([
      this.db.query('SELECT * FROM messages WHERE lead_id=$1 ORDER BY created_at', [id]),
      this.db.query('SELECT * FROM drafts WHERE lead_id=$1 ORDER BY created_at DESC', [id]),
      this.db.query('SELECT id,kind,version,status,metadata,(file_path IS NOT NULL) AS downloadable,created_at FROM documents WHERE lead_id=$1 ORDER BY created_at DESC', [id]),
      this.db.query('SELECT actor,action,details,created_at FROM activities WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 100', [id]),
    ]);
    return { lead, messages: messages.rows, drafts: drafts.rows, documents: documents.rows, activities: activities.rows };
  }

  @Get('leads/:id/agent')
  @UseGuards(AuthGuard)
  async agentState(@Param('id') id: string) {
    return this.salesAgent.state(id);
  }

  @Post('leads/:id/agent/query')
  @UseGuards(AuthGuard)
  async queryAgent(@Param('id') id: string, @Body() body: { question?: string }) {
    const question = String(body.question || '').trim();
    if (!question) throw new BadRequestException('Напишите вопрос агенту');
    return this.salesAgent.answerOwner(id, question);
  }

  @Post('leads/:id/codex-handoff')
  @UseGuards(AuthGuard)
  async buildCodexHandoff(@Param('id') id: string) {
    return this.salesAgent.buildCodexHandoff(id);
  }

  @Post('codex-handoffs/:id/approve')
  @UseGuards(AuthGuard)
  async approveCodexHandoff(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const result = await this.db.transaction(async (client) => {
      const selected = await client.query(
        `SELECT h.*,l.last_inbound_message_id FROM codex_handoffs h
         JOIN leads l ON l.id=h.lead_id WHERE h.id=$1 FOR UPDATE`,
        [id],
      );
      const handoff = selected.rows[0];
      if (!handoff) throw new NotFoundException();
      if (handoff.status !== 'ready') {
        throw new ConflictException('Пакет ещё содержит открытые вопросы');
      }
      if ((handoff.source_last_message_id || null) !== (handoff.last_inbound_message_id || null)) {
        await client.query(
          "UPDATE codex_handoffs SET status='needs_answers',updated_at=now() WHERE id=$1",
          [id],
        );
        throw new ConflictException('После подготовки появились новые сообщения — обновите пакет');
      }
      await client.query(
        `UPDATE codex_handoffs SET status='approved',approved_by=$2,
         approved_at=now(),updated_at=now() WHERE id=$1`,
        [id, req.user!.sub],
      );
      await client.query(
        "UPDATE leads SET pipeline_stage='build_ready',build_readiness=100,next_action='Создать проект Codex',updated_at=now() WHERE id=$1",
        [handoff.lead_id],
      );
      await client.query(
        "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,$2,'codex_handoff_approved',$3)",
        [handoff.lead_id, req.user!.email, JSON.stringify({ handoffId: id, version: handoff.version })],
      );
      return handoff;
    });
    return { ok: true, leadId: result.lead_id, version: result.version };
  }

  @Patch('leads/:id')
  @UseGuards(AuthGuard)
  async updateLead(@Param('id') id: string, @Body() body: { status?: string; requirements?: unknown; client?: unknown; recommendedPrice?: number; recommendedDays?: number }) {
    await this.db.query(`UPDATE leads SET status=COALESCE($2,status),requirements=COALESCE($3,requirements),client=COALESCE($4,client),
      recommended_price=COALESCE($5,recommended_price),recommended_days=COALESCE($6,recommended_days),updated_at=now() WHERE id=$1`,
      [id, body.status || null, body.requirements ? JSON.stringify(body.requirements) : null, body.client ? JSON.stringify(body.client) : null, body.recommendedPrice ?? null, body.recommendedDays ?? null]);
    return { ok: true };
  }

  @Post('leads/:id/analyze')
  @UseGuards(AuthGuard)
  async analyze(@Param('id') id: string) {
    await this.queue.add('analyze-lead', { leadId: id, force: true }, `reanalyze-${id}-${Date.now()}`);
    return { queued: true };
  }

  @Post('leads/:id/draft')
  @UseGuards(AuthGuard)
  async draft(@Param('id') id: string, @Body() body: { channel?: string; targetExternalId?: string }) {
    await this.queue.add(
      'draft-reply',
      { leadId: id, channel: body.channel || 'fl', targetExternalId: body.targetExternalId || '', ownerRequested: true },
      `draft-${id}-${Date.now()}`,
    );
    return { queued: true };
  }

  @Post('leads/:id/documents')
  @UseGuards(AuthGuard)
  async generateDocuments(@Param('id') id: string) {
    await this.queue.add('generate-documents', { leadId: id }, `docs-${id}-${Date.now()}`);
    return { queued: true };
  }

  @Get('drafts')
  @UseGuards(AuthGuard)
  async drafts() {
    return (await this.db.query(`SELECT d.*,l.title AS lead_title,l.score,l.recommended_price,l.recommended_days,
      CASE WHEN d.metadata->>'mode'='chat' THEN 'message' ELSE 'response' END AS draft_type
      FROM drafts d JOIN leads l ON l.id=d.lead_id
      WHERE d.status IN ('pending','approved','sending','failed','stale','send_unknown')
      ORDER BY d.created_at DESC LIMIT 300`)).rows;
  }

  @Patch('drafts/:id')
  @UseGuards(AuthGuard)
  async editDraft(@Param('id') id: string, @Body() body: { content?: string }) {
    if (!body.content?.trim()) throw new ConflictException('Пустой текст');
    const hash = createHash('sha256').update(body.content.trim()).digest('hex');
    const result = await this.db.query(`UPDATE drafts SET content=$2,content_hash=$3,version=version+1,status='pending',approved_by=NULL,approved_at=NULL,error=NULL,
      metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('owner_edited',true),updated_at=now()
      WHERE id=$1 AND status IN ('pending','failed','stale') RETURNING id`, [id, body.content.trim(), hash]);
    if (!result.rows[0]) throw new ConflictException('Этот черновик уже нельзя менять');
    return { ok: true };
  }

  @Post('drafts/:id/regenerate')
  @UseGuards(AuthGuard)
  async regenerateDraft(
    @Param('id') id: string,
    @Body() body: { instructions?: string; recommendedPrice?: number; recommendedDays?: number },
    @Req() req: AuthenticatedRequest,
  ) {
    const draft = (await this.db.query(`SELECT d.*,l.recommended_price,l.recommended_days
      FROM drafts d JOIN leads l ON l.id=d.lead_id WHERE d.id=$1`, [id])).rows[0];
    if (!draft) throw new NotFoundException();
    if (!['pending', 'failed', 'stale'].includes(String(draft.status))) {
      throw new ConflictException('Этот черновик уже нельзя перегенерировать');
    }
    const instructions = String(body.instructions || '').trim().slice(0, 4_000);
    const price = body.recommendedPrice === undefined ? null : Math.round(Number(body.recommendedPrice));
    const days = body.recommendedDays === undefined ? null : Math.round(Number(body.recommendedDays));
    if (price !== null && (!Number.isFinite(price) || price <= 0)) throw new BadRequestException('Цена должна быть больше нуля');
    if (days !== null && (!Number.isFinite(days) || days <= 0)) throw new BadRequestException('Срок должен быть больше нуля');
    if (!instructions && price === null && days === null) throw new BadRequestException('Напишите, что изменить');
    await this.db.query(`UPDATE leads SET recommended_price=COALESCE($2,recommended_price),
      recommended_days=COALESCE($3,recommended_days),updated_at=now() WHERE id=$1`, [draft.lead_id, price, days]);
    await this.db.query(
      "INSERT INTO activities(lead_id,actor,action,details) VALUES($1,$2,'draft_regeneration_requested',$3)",
      [draft.lead_id, req.user!.email, JSON.stringify({ draftId: id, instructions, price, days })],
    );
    const mode = String(draft.metadata?.mode || (draft.kind === 'initial_response' ? 'response' : 'chat'));
    await this.queue.add('draft-reply', {
      leadId: draft.lead_id,
      channel: draft.channel,
      targetExternalId: draft.target_external_id || '',
      mode,
      ownerInstructions: instructions,
      ownerRequested: true,
    }, `regenerate-${id}-${Date.now()}`);
    return { queued: true };
  }

  @Post('drafts/:id/approve')
  @UseGuards(AuthGuard)
  async approve(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const approved = await this.db.transaction(async (client) => {
      const result = await client.query(`SELECT d.*,l.last_inbound_message_id FROM drafts d JOIN leads l ON l.id=d.lead_id WHERE d.id=$1 FOR UPDATE`, [id]);
      const draft = result.rows[0];
      if (!draft) throw new NotFoundException();
      if (draft.status !== 'pending') throw new ConflictException('Черновик уже обработан');
      if ((draft.source_last_message_id || null) !== (draft.last_inbound_message_id || null)) {
        await client.query("UPDATE drafts SET status='stale',updated_at=now() WHERE id=$1", [id]);
        throw new ConflictException('Появилось новое сообщение — нужен свежий ответ');
      }
      await client.query("UPDATE drafts SET status='approved',approved_by=$2,approved_at=now(),updated_at=now() WHERE id=$1", [id, req.user!.sub]);
      await client.query("INSERT INTO activities(lead_id,actor,action,details) VALUES($1,$2,'draft_approved',$3)", [draft.lead_id, req.user!.email, JSON.stringify({ draftId: id, hash: draft.content_hash })]);
      return draft;
    });
    await this.queue.add('send-draft', { draftId: id }, `send-${id}`);
    return { queued: true, hash: approved.content_hash };
  }

  @Post('drafts/:id/reject')
  @UseGuards(AuthGuard)
  async reject(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.db.query("UPDATE drafts SET status='rejected',updated_at=now() WHERE id=$1 AND status IN ('pending','failed','stale')", [id]);
    await this.db.query("INSERT INTO activities(actor,action,details) VALUES($1,'draft_rejected',$2)", [req.user!.email, JSON.stringify({ draftId: id })]);
    return { ok: true };
  }

  @Get('settings')
  @UseGuards(AuthGuard)
  async getSettings() {
    const [seller, style, connectors, telegram, fl, contractTemplate, flCookies] = await Promise.all([
      this.settings.getPublic('seller_profile'), this.settings.getPublic('style_profile'), this.settings.connectorSummary(),
      this.settings.getSecret('telegram_bot_token'), this.settings.getSecret('fl_cookies'),
      this.documents.hasContractTemplate(), this.fl.cookieStatus(),
    ]);
    const codex = connectors.find((item) => String(item.connector) === 'codex');
    return { seller: seller || {}, style: style || {}, connectors, flCookies, configured: { codex: Boolean(codex?.healthy), telegram: Boolean(telegram), fl: Boolean(fl), contractTemplate } };
  }

  @Patch('settings/profile')
  @UseGuards(AuthGuard)
  async saveProfile(@Body() body: { seller?: unknown; style?: unknown }) {
    if (body.seller) await this.settings.setPublic('seller_profile', body.seller);
    if (body.style) await this.settings.setPublic('style_profile', body.style);
    return { ok: true };
  }

  @Post('settings/fl')
  @UseGuards(AuthGuard)
  async configureFl(@Body() body: { cookies?: unknown[]; enabled?: boolean }) {
    if (body.cookies) {
      if (!Array.isArray(body.cookies) || !body.cookies.some((cookie: any) => cookie?.name === 'PHPSESSID')) throw new ConflictException('Нужен массив cookies с PHPSESSID');
      await this.settings.setSecret('fl_cookies', JSON.stringify(body.cookies));
    }
    const enabled = body.enabled ?? true;
    await this.settings.setConnectorState('fl', {
      enabled,
      healthy: false,
      statusText: enabled ? 'Мониторинг включён, ожидает сканирования' : 'Автопроверка FL выключена',
    });
    return { ok: true };
  }

  @Post('settings/telegram')
  @UseGuards(AuthGuard)
  async configureTelegram(@Body() body: { botToken?: string }) {
    if (!body.botToken?.includes(':')) throw new ConflictException('Некорректный bot token');
    await this.settings.setSecret('telegram_bot_token', body.botToken.trim());
    await this.settings.setSecret('telegram_webhook_secret', randomBytes(32).toString('hex'));
    return this.telegram.configureWebhook();
  }

  @Post('settings/contract-template')
  @UseGuards(AuthGuard)
  @UseInterceptors(FileInterceptor('template', { limits: { fileSize: 8 * 1024 * 1024, files: 1 } }))
  async uploadContractTemplate(@UploadedFile() file?: { originalname: string; mimetype: string; buffer: Buffer }) {
    if (!file?.buffer || !file.originalname.toLowerCase().endsWith('.docx')) throw new BadRequestException('Нужен DOCX-шаблон');
    try {
      return await this.documents.saveContractTemplate(file.buffer);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Не удалось сохранить шаблон');
    }
  }

  @Post('connectors/fl/scan')
  @UseGuards(AuthGuard)
  async scanFl() {
    const [projects, chats] = await Promise.all([this.fl.scan({ force: true }), this.fl.syncChats()]);
    return { projects, chats };
  }

  @Get('documents/:id/download')
  @UseGuards(AuthGuard)
  async download(@Param('id') id: string, @Res() res: Response) {
    const document = (await this.db.query<{ file_path: string | null }>('SELECT file_path FROM documents WHERE id=$1', [id])).rows[0];
    if (!document?.file_path) throw new NotFoundException();
    const root = resolve(process.env.DOCUMENTS_DIR || '/app/data/documents');
    const path = resolve(document.file_path);
    if (!path.startsWith(`${root}/`)) throw new UnauthorizedException();
    return res.download(path);
  }
}
