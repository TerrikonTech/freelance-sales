import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { SettingsService } from './settings.service';

@Injectable()
export class CodexTaskService {
  constructor(private readonly db: DatabaseService, private readonly settings: SettingsService) {}

  async run<T>(kind: string, payload: Record<string, unknown>, timeoutMs = 20 * 60_000): Promise<T> {
    const modelTier = ['owner_query', 'owner_overview', 'draft_strategy', 'draft_review', 'conversation_turn'].includes(kind)
      ? 'smart'
      : 'fast';
    const created = await this.db.query<{ id: string }>(
      'INSERT INTO ai_tasks(kind,payload,model_tier) VALUES($1,$2,$3) RETURNING id',
      [kind, JSON.stringify(payload), modelTier],
    );
    const id = created.rows[0].id;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = (await this.db.query<{ status: string; result: T | null; error: string | null }>(
        'SELECT status,result,error FROM ai_tasks WHERE id=$1', [id],
      )).rows[0];
      if (task?.status === 'completed' && task.result) return task.result;
      if (task?.status === 'failed') throw new Error(task.error || 'Codex не выполнил задачу');
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    await this.db.query("UPDATE ai_tasks SET status='failed',error='Время ожидания Codex истекло',updated_at=now() WHERE id=$1 AND status IN ('pending','claimed')", [id]);
    throw new Error('Время ожидания Codex истекло');
  }

  async claim(workerId: string) {
    const result = await this.db.query(
      `UPDATE ai_tasks SET status='claimed',claimed_by=$1,claimed_at=now(),updated_at=now()
       WHERE id=(
         SELECT id FROM ai_tasks WHERE status='pending'
         ORDER BY CASE kind
           WHEN 'owner_query' THEN 0
           WHEN 'owner_overview' THEN 0
           WHEN 'draft_review' THEN 1
           WHEN 'draft_candidates' THEN 2
           WHEN 'draft_reply' THEN 3
           ELSE 4
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
    const statusText = provider === 'hermes' ? 'Hermes подключён' : 'Codex host broker подключён';
    await this.settings.setConnectorState('codex', { enabled: true, healthy: true, statusText, success: true });
    return { ok: true };
  }
}
