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
  | 'sync-fl-chats'
  | 'process-followups'
  | 'health-watchdog'
  | 'owner-command';

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
      attempts: ['send-draft', 'generate-design', 'process-followups', 'health-watchdog'].includes(name)
        ? 1
        : name === 'analyze-lead' ? 2 : 3,
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
