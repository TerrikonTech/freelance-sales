import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export type JobName =
  | 'analyze-lead'
  | 'draft-reply'
  | 'generate-documents'
  | 'send-draft'
  | 'scan-fl'
  | 'sync-fl-chats'
  | 'owner-command';

@Injectable()
export class QueueService implements OnModuleDestroy {
  readonly connection = new IORedis(process.env.REDIS_URL || 'redis://redis:6379', { maxRetriesPerRequest: null });
  readonly queue = new Queue('sales', { connection: this.connection });

  async add(name: JobName, data: Record<string, unknown>, jobId?: string) {
    return this.queue.add(name, data, {
      jobId,
      // Outbound operations own their retry semantics through the durable
      // delivery ledger.  BullMQ must never replay a possibly delivered send.
      attempts: name === 'send-draft' ? 1 : name === 'analyze-lead' ? 2 : 3,
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
