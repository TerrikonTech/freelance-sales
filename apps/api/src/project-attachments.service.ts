import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { PDFParse } from 'pdf-parse';
import PizZip from 'pizzip';

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

  async download(projectId: string, links: Array<{ url: string; name?: string }>): Promise<ProjectAttachment[]> {
    const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'project';
    const root = join(process.env.DOCUMENTS_DIR || '/app/data/documents', 'project-files', safeProjectId);
    await mkdir(root, { recursive: true });
    const results: ProjectAttachment[] = [];
    let totalBytes = 0;
    for (const [index, link] of links.slice(0, 8).entries()) {
      if (!this.allowed(link.url) || totalBytes >= this.maxTotalBytes) continue;
      try {
        const response = await fetch(link.url, {
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; FreelanceSales/2.0)' },
          redirect: 'follow',
          signal: AbortSignal.timeout(35_000),
        });
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

  private allowed(value: string) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return url.protocol === 'https:' && (host === 'st.fl.ru' || host === 'www.fl.ru' || host === 'fl.ru');
    } catch {
      return false;
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
