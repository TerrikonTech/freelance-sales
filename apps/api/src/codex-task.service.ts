import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { JobProgressService } from './job-progress.service';
import { SettingsService } from './settings.service';

@Injectable()
export class CodexTaskService {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly progress: JobProgressService,
  ) {}

  /**
   * Per-kind wait ceilings. A healthy broker answers in tens of seconds, so a task
   * that outlives its kind's ceiling is stuck (dead broker, wedged HTTP call) —
   * fail it fast instead of stalling the whole job. The old single 20-minute
   * default is exactly what made one hung call freeze a draft for minutes.
   */
  private static readonly KIND_TIMEOUTS_MS: Record<string, number> = {
    owner_query: 240_000,
    owner_overview: 240_000,
    owner_intent: 120_000,
    // Compose measured 2.5-7 min on real long briefs (2026-09-10): 240 s cut off
    // 3 of 5 live drafts. 8 min is still far below the old 20-min hang.
    draft_compose: 180_000,
    draft_reply: 300_000,
    conversation_turn: 180_000,
    lead_analysis_v2: 120_000,
    specification: 360_000,
    contract_data: 240_000,
    design_concept_brief: 300_000,
    design_concept_html: 300_000,
  };

  // Драфты чувствительны к задержке: один повтор при зависании брокера
  // вместо старого 8-минутного ожидания. Второй заход почти всегда быстрый.
  async run<T>(kind: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    try {
      return await this.runOnce<T>(kind, payload, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = kind === 'draft_compose' || kind === 'draft_reply';
      if (retryable && message.includes('Время ожидания истекло')) {
        return this.runOnce<T>(kind, payload, timeoutMs);
      }
      throw error;
    }
  }

  private async runOnce<T>(kind: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    // The owner sees this stage light up the moment the AI call starts.
    await this.progress.advanceForAiKind(kind).catch(() => undefined);
    const effectiveTimeoutMs = timeoutMs ?? CodexTaskService.KIND_TIMEOUTS_MS[kind] ?? 300_000;
    const modelTier = ['owner_query', 'owner_overview', 'draft_compose', 'conversation_turn'].includes(kind)
      ? 'smart'
      : 'fast';
    const created = await this.db.query<{ id: string }>(
      'INSERT INTO ai_tasks(kind,payload,model_tier) VALUES($1,$2,$3) RETURNING id',
      [kind, JSON.stringify(payload), modelTier],
    );
    const id = created.rows[0].id;
    const deadline = Date.now() + effectiveTimeoutMs;
    const startedAt = Date.now();
    let lastBeat = Date.now();
    let queueReported = false;
    let startReported = false;
    while (Date.now() < deadline) {
      const task = (await this.db.query<{ status: string; result: T | null; error: string | null }>(
        'SELECT status,result,error FROM ai_tasks WHERE id=$1', [id],
      )).rows[0];
      if (task?.status === 'completed' && task.result) return task.result;
      if (task?.status === 'failed') throw new Error(task.error || 'Codex не выполнил задачу');
      // Waiting on a busy AI worker looks identical to a hang from the outside.
      // Say which of the two is happening.
      if (task?.status === 'claimed' && !startReported) {
        startReported = true;
        await this.progress.note('ИИ пишет ответ').catch(() => undefined);
      } else if (task?.status === 'pending' && !queueReported && Date.now() - startedAt > 8_000) {
        queueReported = true;
        await this.progress.note('жду свободный ИИ-воркер').catch(() => undefined);
      }
      if (Date.now() - lastBeat > 15_000) {
        lastBeat = Date.now();
        await this.progress.touch().catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    await this.db.query(
      "UPDATE ai_tasks SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status IN ('pending','claimed')",
      [id, `Время ожидания истекло (${Math.round(effectiveTimeoutMs / 1000)} с): брокер завис или недоступен`],
    );
    throw new Error(`Время ожидания истекло: задача ${kind} не выполнена за ${Math.round(effectiveTimeoutMs / 1000)} с`);
  }

  async claim(workerId: string) {
    const result = await this.db.query(
      `UPDATE ai_tasks SET status='claimed',claimed_by=$1,claimed_at=now(),updated_at=now()
       WHERE id=(
         SELECT id FROM ai_tasks WHERE status='pending'
         ORDER BY CASE kind
           WHEN 'owner_query' THEN 0
           WHEN 'owner_overview' THEN 0
           WHEN 'draft_compose' THEN 2
           WHEN 'draft_reply' THEN 3
           WHEN 'conversation_turn' THEN 4
           ELSE 5
         END, created_at
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id,kind,payload,model_tier,created_at`,
      [workerId.slice(0, 120)],
    );
    return result.rows[0] || null;
  }

  async complete(id: string, result: Record<string, unknown>) {
    const updated = await this.db.query(
      `UPDATE ai_tasks SET status='completed',result=$2,error=NULL,completed_at=now(),
       duration_ms=GREATEST(0,extract(epoch FROM (now()-created_at))*1000)::int,updated_at=now()
       WHERE id=$1 AND status='claimed' RETURNING id`,
      [id, JSON.stringify(result)],
    );
    if (!updated.rows[0]) throw new Error('AI-задача уже завершена или не найдена');
    return { ok: true };
  }

  async fail(id: string, error: string) {
    await this.db.query(
      "UPDATE ai_tasks SET status='failed',error=$2,completed_at=now(),updated_at=now() WHERE id=$1 AND status IN ('pending','claimed')",
      [id, error.slice(0, 1000)],
    );
    return { ok: true };
  }

  async heartbeat(provider?: string) {
    const statusText = 'OpenRouter брокер подключён';
    await this.settings.setConnectorState('codex', { enabled: true, healthy: true, statusText, success: true });
    return { ok: true };
  }
}
