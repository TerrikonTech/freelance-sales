import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 12,
    idleTimeoutMillis: 30_000,
  });

  async onModuleInit() {
    const schemaPath = join(__dirname, '..', 'sql', 'schema.sql');
    const schema = await readFile(schemaPath, 'utf8');
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [73_150_021]);
      await client.query(schema);
      this.logger.log('Database schema is ready');
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [73_150_021]).catch(() => undefined);
      client.release();
    }
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
