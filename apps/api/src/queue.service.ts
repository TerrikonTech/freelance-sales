import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export type JobName =
  | 'analyze-lead'
  | 'draft-reply'
  | 'generate-documents'
  | 'generate-design'
  | 'send-draft'
  | 'scan-fl'
  | 'sync-fl-portfolio'
  | 'sync-fl-chats'
  | 'process-followups'
  | 'health-watchdog'
  | 'owner-command';

export function queuePriorityFor(name: JobName) {
  if (name === 'scan-fl') return 1;
  if (['owner-command', 'send-draft', 'draft-reply'].includes(name)) return 2;
  if (name === 'analyze-lead') return 3;
  if (name === 'sync-fl-chats') return 4;
  return 20;
}

export function queueAttemptsFor(name: JobName) {
  if (['scan-fl', 'sync-fl-portfolio', 'send-draft', 'generate-design', 'process-followups', 'health-watchdog'].includes(name)) {
    return 1;
  }
  return name === 'analyze-lead' ? 2 : 3;
}

@Injectable()
export class QueueService implements OnModuleDestroy {
  readonly connection = new IORedis(process.env.REDIS_URL || 'redis://redis:6379', { maxRetriesPerRequest: null });
  readonly queue = new Queue('sales', { connection: this.connection });

  async add(name: JobName, data: Record<string, unknown>, jobId?: string, options?: { delayMs?: number }) {
    return this.queue.add(name, data, {
      jobId,
      delay: Math.max(0, Number(options?.delayMs || 0)) || undefined,
      // Outbound operations own their retry semantics through the durable
      // delivery ledger.  BullMQ must never replay a possibly delivered send.
      attempts: queueAttemptsFor(name),
      priority: queuePriorityFor(name),
      backoff: { type: 'exponential', delay: 3_000 },
      removeOnComplete: 500,
      removeOnFail: 500,
    });
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit();
  }
}
