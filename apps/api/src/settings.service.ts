import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { CryptoService } from './crypto.service';

@Injectable()
export class SettingsService {
  constructor(private readonly db: DatabaseService, private readonly crypto: CryptoService) {}

  async getPublic<T = unknown>(key: string): Promise<T | null> {
    const result = await this.db.query<{ public_value: T }>('SELECT public_value FROM settings WHERE key=$1', [key]);
    return result.rows[0]?.public_value ?? null;
  }

  async setPublic(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO settings(key, public_value, updated_at) VALUES($1,$2,now())
       ON CONFLICT(key) DO UPDATE SET public_value=EXCLUDED.public_value, updated_at=now()`,
      [key, JSON.stringify(value)],
    );
  }

  async getSecret(key: string): Promise<string | null> {
    const result = await this.db.query<{ encrypted_value: string | null }>('SELECT encrypted_value FROM settings WHERE key=$1', [key]);
    const encrypted = result.rows[0]?.encrypted_value;
    return encrypted ? this.crypto.decrypt(encrypted) : null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    const encrypted = this.crypto.encrypt(value);
    await this.db.query(
      `INSERT INTO settings(key, encrypted_value, updated_at) VALUES($1,$2,now())
       ON CONFLICT(key) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value, updated_at=now()`,
      [key, encrypted],
    );
  }

  async connectorSummary() {
    const result = await this.db.query(
      'SELECT connector,enabled,healthy,status_text,cursor,last_success_at,updated_at FROM connector_state ORDER BY connector',
    );
    return result.rows;
  }

  async setConnectorState(connector: string, patch: { enabled?: boolean; healthy?: boolean; statusText?: string; success?: boolean }) {
    await this.db.query(
      `UPDATE connector_state SET
        enabled=COALESCE($2,enabled), healthy=COALESCE($3,healthy),
        status_text=COALESCE($4,status_text),
        last_success_at=CASE WHEN $5 THEN now() ELSE last_success_at END,
        updated_at=now() WHERE connector=$1`,
      [connector, patch.enabled ?? null, patch.healthy ?? null, patch.statusText ?? null, patch.success ?? false],
    );
  }
}
