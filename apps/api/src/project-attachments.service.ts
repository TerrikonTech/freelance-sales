import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { PDFParse } from 'pdf-parse';
import PizZip from 'pizzip';
import { SettingsService } from './settings.service';

export type ProjectAttachment = {
  name: string;
  url: string;
  content_type: string;
  size: number;
  sha256: string;
  local_path: string;
  extracted_text: string;
  extraction: 'text' | 'image' | 'stored';
};

@Injectable()
export class ProjectAttachmentsService {
  private readonly logger = new Logger(ProjectAttachmentsService.name);
  private readonly maxFileBytes = 15 * 1024 * 1024;
  private readonly maxTotalBytes = 40 * 1024 * 1024;
  private static readonly flHosts = new Set(['st.fl.ru', 'www.fl.ru', 'fl.ru']);

  constructor(private readonly settings: SettingsService) {}

  async download(projectId: string, links: Array<{ url: string; name?: string }>): Promise<ProjectAttachment[]> {
    const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'project';
    const root = join(process.env.DOCUMENTS_DIR || '/app/data/documents', 'project-files', safeProjectId);
    await mkdir(root, { recursive: true });
    const results: ProjectAttachment[] = [];
    let totalBytes = 0;
    const cookieHeader = await this.flCookieHeader();
    for (const [index, link] of links.slice(0, 8).entries()) {
      if (!this.allowed(link.url) || totalBytes >= this.maxTotalBytes) continue;
      try {
        // FL отдаёт файл 302-редиректом на предподписанную ссылку хранилища.
        // Редирект обрабатываем вручную: cookies FL уходят только на fl.ru,
        // до хранилища они доходить не должны.
        const flHost = this.isFlHost(link.url);
        let response = await fetch(link.url, {
          headers: {
            'user-agent': 'Mozilla/5.0 (compatible; FreelanceSales/2.0)',
            ...(flHost && cookieHeader ? { cookie: cookieHeader, referer: 'https://www.fl.ru/' } : {}),
          },
          redirect: flHost ? 'manual' : 'follow',
          signal: AbortSignal.timeout(35_000),
        });
        if (flHost && response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location || !this.allowed(new URL(location, link.url).toString())) {
            this.logger.warn(`FL attachment skipped: redirect to non-allowed host ${location ? new URL(location, link.url).host : '(none)'}`);
            continue;
          }
          response = await this.fetchStorage(new URL(location, link.url).toString());
        }
        if (!response.ok || !this.allowed(response.url)) continue;
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > this.maxFileBytes || declared + totalBytes > this.maxTotalBytes) continue;
        const buffer = await this.readLimited(response, Math.min(this.maxFileBytes, this.maxTotalBytes - totalBytes));
        if (!buffer.length) continue;
        totalBytes += buffer.length;
        const contentType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
        const name = this.fileName(response, link.name || '', index, contentType);
        const localName = `${String(index + 1).padStart(2, '0')}-${name}`;
        const localPath = join('project-files', safeProjectId, localName);
        await writeFile(join(root, localName), buffer, { mode: 0o600 });
        const extracted = await this.extract(buffer, name, contentType);
        results.push({
          name,
          url: response.url,
          content_type: contentType,
          size: buffer.length,
          sha256: createHash('sha256').update(buffer).digest('hex'),
          local_path: localPath,
          extracted_text: extracted.text.slice(0, 30_000),
          extraction: extracted.kind,
        });
      } catch (error) {
        this.logger.warn(`FL attachment skipped: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    return results;
  }

  // Хранилище FL может быть недоступно с этого сервера (у провайдера заблокирован
  // TLS к selcloud). Сначала пробуем напрямую, при сетевом сбое — через релей
  // на Cloudflare Worker (ATTACHMENT_RELAY_URL + ATTACHMENT_RELAY_KEY).
  private async fetchStorage(url: string) {
    try {
      return await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; FreelanceSales/2.0)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      const relay = process.env.ATTACHMENT_RELAY_URL;
      const key = process.env.ATTACHMENT_RELAY_KEY;
      if (!relay || !key) throw error;
      const direct = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`FL attachment: storage fetch failed (${direct.slice(0, 80)}), retrying via relay`);
      const joiner = relay.includes('?') ? '&' : '?';
      const relayUrl = `${relay}${joiner}key=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}`;
      return await fetch(relayUrl, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; FreelanceSales/2.0)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(60_000),
      });
    }
  }

  private allowed(value: string) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return url.protocol === 'https:' && (this.isFlHost(host) || host.endsWith('.storage.selcloud.ru'));
    } catch {
      return false;
    }
  }

  private isFlHost(value: string) {
    try {
      return ProjectAttachmentsService.flHosts.has(new URL(value, 'https://fl.ru').hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  private async flCookieHeader(): Promise<string | null> {
    try {
      const raw = await this.settings.getSecret('fl_cookies');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Array<{ name?: string; value?: string; domain?: string }>;
      const pairs = parsed
        .filter((cookie) => cookie.name && cookie.value && (!cookie.domain || /(^|\.)fl\.ru$/i.test(cookie.domain)))
        .map((cookie) => `${cookie.name}=${cookie.value}`);
      return pairs.length ? pairs.join('; ') : null;
    } catch (error) {
      this.logger.warn(`FL cookies unavailable for attachments: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  private async readLimited(response: Response, limit: number) {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('attachment exceeds size limit');
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }

  private fileName(response: Response, hint: string, index: number, contentType: string) {
    const disposition = response.headers.get('content-disposition') || '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
    let value = encoded ? decodeURIComponent(encoded) : plain || hint;
    if (!value) value = basename(new URL(response.url).pathname) || `attachment-${index + 1}`;
    value = basename(value).replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/\s+/g, ' ').slice(0, 110);
    if (!extname(value)) value += this.extension(contentType);
    return value || `attachment-${index + 1}.bin`;
  }

  private extension(contentType: string) {
    if (contentType === 'application/pdf') return '.pdf';
    if (contentType.includes('wordprocessingml')) return '.docx';
    if (contentType.includes('spreadsheetml')) return '.xlsx';
    if (contentType.startsWith('image/')) return `.${contentType.split('/')[1].replace('jpeg', 'jpg')}`;
    if (contentType.startsWith('text/')) return '.txt';
    return '.bin';
  }

  private async extract(buffer: Buffer, name: string, contentType: string): Promise<{ text: string; kind: 'text' | 'image' | 'stored' }> {
    const extension = extname(name).toLowerCase();
    if (contentType.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) {
      return { text: '', kind: 'image' };
    }
    if (contentType === 'application/pdf' || extension === '.pdf') {
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        return { text: this.clean(result.text), kind: 'text' };
      } finally {
        await parser.destroy();
      }
    }
    if (['.docx', '.xlsx', '.pptx'].includes(extension) || /officedocument/.test(contentType)) {
      return { text: this.extractOffice(buffer, extension), kind: 'text' };
    }
    if (contentType.startsWith('text/') || ['.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm'].includes(extension)) {
      const raw = buffer.toString('utf8');
      const text = ['.html', '.htm'].includes(extension) || contentType === 'text/html' ? cheerio.load(raw).text() : raw;
      return { text: this.clean(text), kind: 'text' };
    }
    return { text: '', kind: 'stored' };
  }

  private extractOffice(buffer: Buffer, extension: string) {
    const zip = new PizZip(buffer);
    const targets = Object.keys(zip.files).filter((name) => {
      if (extension === '.docx') return name === 'word/document.xml' || /^word\/(header|footer)\d+\.xml$/.test(name);
      if (extension === '.pptx') return /^ppt\/slides\/slide\d+\.xml$/.test(name);
      return name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
    }).slice(0, 100);
    const parts: string[] = [];
    for (const target of targets) {
      const entry = zip.file(target);
      const uncompressed = Number((entry as any)?._data?.uncompressedSize || 0);
      if (!entry || uncompressed > 5 * 1024 * 1024) continue;
      const xml = entry.asText();
      const $ = cheerio.load(xml, { xmlMode: true });
      parts.push($('w\\:t, a\\:t, t, v').map((_, element) => $(element).text()).get().join(' '));
      if (parts.join(' ').length > 30_000) break;
    }
    return this.clean(parts.join('\n'));
  }

  private clean(value: string) {
    return value.replace(/\0/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
}
