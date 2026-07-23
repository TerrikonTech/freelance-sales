import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor() {
    const raw = process.env.ENCRYPTION_KEY || '';
    if (!/^[a-f0-9]{64}$/i.test(raw)) {
      throw new Error('ENCRYPTION_KEY must be exactly 64 hexadecimal characters');
    }
    this.key = Buffer.from(raw, 'hex');
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.');
  }

  decrypt(payload: string): string {
    const [ivRaw, tagRaw, dataRaw] = payload.split('.');
    if (!ivRaw || !tagRaw || !dataRaw) throw new Error('Invalid encrypted payload');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
