import { Injectable, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseService } from './database.service';

export type JobStepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed';

export interface JobStep {
  key: string;
  label: string;
  status: JobStepStatus;
  note?: string;
  attempts?: number;
  started_at?: string;
  ended_at?: string;
}

export interface JobPlan {
  title: string;
  steps: JobStep[];
}

interface JobStore {
  id: string;
}

/**
 * The owner presses a button and the work happens minutes later inside the worker.
 * These plans are what the interface shows meanwhile: named steps in the order they
 * normally occur.  Steps that a particular run never reaches are marked "не потребовалось"
 * instead of hanging forever, so a chat reply is not shown as a stuck proposal.
 */
const PLANS: Record<string, { title: string; steps: [string, string][] }> = {
  'analyze-lead': {
    title: 'Оцениваю заказ',
    steps: [
      ['prepare', 'Читаю заказ, бюджет и вложения'],
      ['analysis', 'ИИ считает релевантность, цену и срок'],
      ['save', 'Сохраняю оценку и решаю, подходит ли заказ'],
    ],
  },
  'draft-reply': {
    title: 'Готовлю текст ответа',
    steps: [
      ['prepare', 'Собираю контекст: заказ, переписку и ваши кейсы'],
      ['turn', 'Разбираю, что спросил клиент и что отвечать'],
      ['compose', 'Пишу и сразу проверяю готовый отклик'],
      ['save', 'Сохраняю черновик — он ждёт вашего решения'],
    ],
  },
  'generate-documents': {
    title: 'Собираю ТЗ и договор',
    steps: [
      ['prepare', 'Собираю подтверждённые требования'],
      ['spec', 'Пишу техническое задание'],
      ['contract', 'Готовлю данные договора'],
      ['save', 'Сохраняю документы'],
    ],
  },
  'generate-design': {
    title: 'Рисую дизайн-концепции',
    steps: [
      ['prepare', 'Читаю требования проекта'],
      ['design_brief', 'ИИ формулирует концепции'],
      ['design_html', 'Собираю HTML-макеты'],
      ['render', 'Рендерю PNG в Chromium'],
      ['save', 'Сохраняю изображения'],
    ],
  },
  'send-draft': {
    title: 'Отправляю одобренный текст',
    steps: [
      ['prepare', 'Проверяю предохранители перед отправкой'],
      ['send', 'Отправляю в канал клиента'],
      ['confirm', 'Записываю результат в журнал доставок'],
    ],
  },
  'scan-fl': {
    title: 'Проверяю новые заказы на FL.ru',
    steps: [
      ['fetch', 'Открываю ленту заказов'],
      ['dedupe', 'Отбрасываю уже известные заказы'],
      ['read', 'Сразу добавляю новые заказы на Dashboard'],
      ['save', 'Ставлю новые заказы на оценку'],
    ],
  },
  'sync-fl-chats': {
    title: 'Синхронизирую чаты FL.ru',
    steps: [
      ['fetch', 'Читаю список диалогов'],
      ['messages', 'Забираю новые сообщения'],
      ['save', 'Обновляю чаты и уведомления'],
    ],
  },
  'owner-command': {
    title: 'Разбираю вашу команду',
    steps: [
      ['prepare', 'Читаю сообщение и историю'],
      ['intent', 'Определяю, что именно вы просите'],
      ['answer', 'Готовлю ответ или действие'],
    ],
  },
};

/**
 * Every Codex call maps onto the step it belongs to, so the plan advances without
 * threading a progress object through the whole AI layer.
 */
const AI_KIND_STEPS: Record<string, [string, string]> = {
  lead_analysis_v2: ['analysis', 'ИИ считает релевантность, цену и срок'],
  portfolio_pick: ['strategy', 'Подбираю кейс, который реально совпадает по механике'],
  draft_compose: ['compose', 'Пишу и сразу проверяю готовый отклик'],
  draft_strategy: ['strategy', 'Придумываю, о чём писать в отклике'],
  draft_candidates: ['candidates', 'Пишу несколько вариантов текста'],
  draft_review: ['review', 'Проверяю на живость текста и на выдуманные факты'],
  draft_reply: ['candidates', 'Пишу текст ответа'],
  conversation_turn: ['turn', 'Разбираю, что спросил клиент и что отвечать'],
  specification: ['spec', 'Пишу техническое задание'],
  contract_data: ['contract', 'Готовлю данные договора'],
  design_concept_brief: ['design_brief', 'ИИ формулирует концепции'],
  design_concept_html: ['design_html', 'Собираю HTML-макеты'],
  owner_intent: ['intent', 'Определяю, что именно вы просите'],
  owner_query: ['answer', 'Ищу ответ по переписке'],
  owner_overview: ['answer', 'Собираю сводку по заказам'],
};

export function planFor(kind: string): JobPlan {
  const plan = PLANS[kind];
  if (!plan) return { title: kind, steps: [] };
  return {
    title: plan.title,
    steps: plan.steps.map(([key, label]) => ({ key, label, status: 'pending' as JobStepStatus })),
  };
}

/**
 * Applies one stage transition to a step list.  Repeated entry into the same step
 * (Codex retries a rejected draft) increments the attempt counter instead of
 * duplicating the row, and steps the run jumped over become "не потребовалось".
 */
export function advanceSteps(steps: JobStep[], key: string, label: string, note?: string, at = new Date()): JobStep[] {
  const stamp = at.toISOString();
  const next = steps.map((step) => ({ ...step }));
  const index = next.findIndex((step) => step.key === key);
  if (index >= 0 && next[index].status === 'active') {
    // A step opened by track() carries attempts=0, so the first real advance into it
    // is the first attempt — not a retry.  Only a genuine second entry says "попытка 2".
    const previous = next[index].attempts || 0;
    next[index].attempts = previous + 1;
    if (previous >= 1) next[index].note = note || `попытка ${previous + 1}`;
    else if (note) next[index].note = note;
    return next;
  }
  for (const step of next) {
    if (step.status === 'active') { step.status = 'done'; step.ended_at = stamp; }
  }
  if (index < 0) {
    next.push({ key, label, status: 'active', attempts: 1, started_at: stamp, ...(note ? { note } : {}) });
    return next;
  }
  for (let position = 0; position < index; position += 1) {
    if (next[position].status === 'pending') next[position].status = 'skipped';
  }
  next[index] = { ...next[index], label: next[index].label || label, status: 'active', attempts: 1, started_at: stamp, ...(note ? { note } : {}) };
  return next;
}

export function finishSteps(steps: JobStep[], ok: boolean, at = new Date()): JobStep[] {
  const stamp = at.toISOString();
  return steps.map((step) => {
    if (step.status === 'active') return { ...step, status: ok ? 'done' as JobStepStatus : 'failed' as JobStepStatus, ended_at: stamp };
    if (step.status === 'pending') return { ...step, status: 'skipped' as JobStepStatus };
    return step;
  });
}

@Injectable()
export class JobProgressService {
  private readonly logger = new Logger(JobProgressService.name);
  private readonly storage = new AsyncLocalStorage<JobStore>();

  constructor(private readonly db: DatabaseService) {}

  /**
   * Runs `fn` while recording a visible progress row.  Progress is best-effort:
   * a failure to write it must never break the actual work the owner asked for.
   */
  async track<T>(kind: string, options: { leadId?: string | null; title?: string }, fn: () => Promise<T>): Promise<T> {
    const plan = planFor(kind);
    const title = options.title || plan.title || kind;
    // Open on the plan's own first step.  Forcing a generic "prepare" here would append
    // it to the end of plans that do not have one, and the owner would read the list
    // out of order.
    const opening = (plan.steps.length
      ? advanceSteps(plan.steps, plan.steps[0].key, plan.steps[0].label)
      : advanceSteps([], 'prepare', 'Готовлю данные')
    ).map((step) => (step.status === 'active' ? { ...step, attempts: 0 } : step));
    let id = '';
    try {
      const created = await this.db.query<{ id: string }>(
        'INSERT INTO job_runs(kind,lead_id,title,steps) VALUES($1,$2,$3,$4) RETURNING id',
        [kind, options.leadId || null, title, JSON.stringify(opening)],
      );
      id = created.rows[0].id;
    } catch (error) {
      this.logger.warn(`Progress row skipped for ${kind}: ${error instanceof Error ? error.message : 'unknown'}`);
      return fn();
    }
    try {
      const value = await this.storage.run({ id }, fn);
      await this.close(id, true, null);
      return value;
    } catch (error) {
      await this.close(id, false, error instanceof Error ? error.message : 'Неизвестная ошибка');
      throw error;
    }
  }

  /** Marks the named step as the one running right now. No-op outside a tracked job. */
  async advance(key: string, label: string, note?: string) {
    const store = this.storage.getStore();
    if (!store) return;
    await this.patch(store.id, (steps) => advanceSteps(steps, key, label, note));
  }

  /** Maps a Codex task kind onto the plan step it belongs to. */
  async advanceForAiKind(kind: string) {
    const mapped = AI_KIND_STEPS[kind];
    if (mapped) return this.advance(mapped[0], mapped[1]);
    return this.advance(`ai:${kind}`, `ИИ выполняет задачу «${kind}»`);
  }

  /** Adds a short human note to the step currently running. */
  async note(text: string) {
    const store = this.storage.getStore();
    if (!store) return;
    await this.patch(store.id, (steps) => steps.map((step) => (step.status === 'active' ? { ...step, note: text.slice(0, 200) } : step)));
  }

  /** Replaces the headline once the run knows what it is actually doing. */
  async retitle(title: string) {
    const store = this.storage.getStore();
    if (!store) return;
    await this.db.query('UPDATE job_runs SET title=$2,updated_at=now() WHERE id=$1', [store.id, title.slice(0, 200)])
      .catch(() => undefined);
  }

  async describe(text: string) {
    const store = this.storage.getStore();
    if (!store) return;
    await this.db.query('UPDATE job_runs SET result_text=$2,updated_at=now() WHERE id=$1', [store.id, text.slice(0, 500)])
      .catch(() => undefined);
  }

  /**
   * Keeps a long AI wait distinguishable from a dead process: a run that stops
   * ticking is treated as interrupted instead of spinning in the interface forever.
   */
  async touch() {
    const store = this.storage.getStore();
    if (!store) return;
    await this.db.query('UPDATE job_runs SET updated_at=now() WHERE id=$1 AND status=\'running\'', [store.id])
      .catch(() => undefined);
  }

  activeJobId() {
    return this.storage.getStore()?.id || null;
  }

  private async patch(id: string, apply: (steps: JobStep[]) => JobStep[]) {
    try {
      const current = await this.db.query<{ steps: JobStep[] }>('SELECT steps FROM job_runs WHERE id=$1', [id]);
      const steps = current.rows[0]?.steps;
      if (!Array.isArray(steps)) return;
      await this.db.query('UPDATE job_runs SET steps=$2,updated_at=now() WHERE id=$1', [id, JSON.stringify(apply(steps))]);
    } catch (error) {
      this.logger.warn(`Progress update skipped: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private async close(id: string, ok: boolean, error: string | null) {
    try {
      const current = await this.db.query<{ steps: JobStep[] }>('SELECT steps FROM job_runs WHERE id=$1', [id]);
      const steps = Array.isArray(current.rows[0]?.steps) ? current.rows[0].steps : [];
      await this.db.query(
        `UPDATE job_runs SET status=$2,steps=$3,error=$4,finished_at=now(),updated_at=now() WHERE id=$1`,
        [id, ok ? 'completed' : 'failed', JSON.stringify(finishSteps(steps, ok)), error ? error.slice(0, 500) : null],
      );
    } catch (updateError) {
      this.logger.warn(`Progress close skipped: ${updateError instanceof Error ? updateError.message : 'unknown'}`);
    }
  }

  /**
   * A worker restart leaves rows stuck in "running" forever, which would show the
   * owner permanent fake activity.  Running jobs heartbeat, so anything untouched for
   * five minutes is closed as interrupted, and old history is trimmed.
   */
  async sweep() {
    await this.db.query(
      `UPDATE job_runs SET status='failed',error=COALESCE(error,'Работа прервана: сервис перезапустился'),
         finished_at=now(),updated_at=now()
       WHERE status='running' AND updated_at < now()-interval '5 minutes'`,
    ).catch(() => undefined);
    await this.db.query("DELETE FROM job_runs WHERE started_at < now()-interval '14 days'").catch(() => undefined);
  }

  async feed(options: { leadId?: string; includeSandbox?: boolean; limit?: number } = {}) {
    const limit = Math.min(50, Math.max(5, Number(options.limit || 12)));
    const filters: string[] = [];
    const params: unknown[] = [];
    if (options.leadId) { params.push(options.leadId); filters.push(`j.lead_id=$${params.length}`); }
    if (!options.includeSandbox) filters.push("COALESCE(l.source,'')<>'sandbox'");
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = await this.db.query(
      `SELECT j.id,j.kind,j.lead_id,j.title,j.status,j.steps,j.result_text,j.error,
              j.started_at,j.updated_at,j.finished_at,l.title AS lead_title,l.source AS lead_source
         FROM job_runs j LEFT JOIN leads l ON l.id=j.lead_id
         ${where}
         ORDER BY CASE j.status WHEN 'running' THEN 0 ELSE 1 END, j.started_at DESC
         LIMIT ${limit}`,
      params,
    );
    const stuckAt = Date.now() - 5 * 60_000;
    const jobs = rows.rows.map((row: any) => ({
      ...row,
      status: row.status === 'running' && new Date(row.updated_at).getTime() < stuckAt ? 'failed' : row.status,
    }));
    return { active: jobs.filter((job: any) => job.status === 'running'), recent: jobs.filter((job: any) => job.status !== 'running') };
  }
}
