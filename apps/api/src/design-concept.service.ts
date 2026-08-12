import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer-core';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { CodexTaskService } from './codex-task.service';
import { DatabaseService } from './database.service';
import { JobProgressService } from './job-progress.service';
import { SettingsService } from './settings.service';

const IMAGE_MODEL = 'gpt-image-2';
const IMAGE_SIZE = '1536x1024';
const IMAGE_QUALITY = 'low';
const IMAGE_COST_USD = 0.005;
const MAX_REFERENCE_BYTES = 1_000_000;
/** Codex authors HTML/CSS; we rasterise it ourselves. "openai" keeps the old image API. */
export function designEngine(): string {
  return String(process.env.DESIGN_ENGINE || 'codex').trim().toLowerCase();
}
const MOCKUP_WIDTH = 1536;
const MOCKUP_HEIGHT = 1024;
const MAX_MOCKUP_HTML = 400_000;

export type DesignBrief = {
  title: string;
  visual_direction: string;
  rationale: string;
  client_caption: string;
  image_prompt: string;
};

export type DesignAsset = {
  id: string;
  filePath: string;
  contentType: string;
  publicUrl: string;
};

export type DesignConceptResult = {
  brief: DesignBrief;
  assets: DesignAsset[];
  estimatedCostUsd: number;
};

export function isBlockedIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number);
    const [a, b] = parts;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  if (isIP(normalized) === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    if (/^(?:fc|fd|fe8|fe9|fea|feb|ff)/i.test(normalized)) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
    return mapped ? isBlockedIpAddress(mapped) : false;
  }
  return true;
}

export function validateReferenceUrlSyntax(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Ссылка должна использовать HTTP или HTTPS');
  if (url.username || url.password) throw new Error('Ссылки со встроенным логином запрещены');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Нестандартный порт в ссылке запрещён');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Локальные адреса в ссылках запрещены');
  }
  if (isIP(host) && isBlockedIpAddress(host)) throw new Error('Приватные адреса в ссылках запрещены');
  return url;
}

@Injectable()
export class DesignConceptService {
  private readonly root = resolve(process.env.DOCUMENTS_DIR || '/app/data/documents');

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly tasks: CodexTaskService,
    private readonly progress: JobProgressService,
  ) {}

  async configured(): Promise<boolean> {
    // Codex goes through the same Hermes queue as every other task, so it is always available.
    if (designEngine() !== 'openai') return true;
    return Boolean(await this.settings.getSecret('openai_image_api_key') || process.env.OPENAI_IMAGE_API_KEY);
  }

  estimate(count: number) {
    if (designEngine() !== 'openai') return 0;
    return Number((Math.max(1, Math.min(4, count)) * IMAGE_COST_USD).toFixed(3));
  }

  async generate(
    leadId: string,
    instructions: string,
    referenceUrl: string | null,
    requestedCount: number,
  ): Promise<DesignConceptResult> {
    const openAiEngine = designEngine() === 'openai';
    const apiKey = await this.settings.getSecret('openai_image_api_key') || process.env.OPENAI_IMAGE_API_KEY;
    if (openAiEngine && !apiKey) {
      throw new Error('Генерация изображений не подключена: добавьте OpenAI Images API key в настройках');
    }
    const lead = (await this.db.query('SELECT * FROM leads WHERE id=$1', [leadId])).rows[0];
    if (!lead) throw new Error('Клиент или сделка не найдены');
    const messages = (await this.db.query(
      `SELECT direction,author,content,created_at FROM messages
       WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 80`,
      [leadId],
    )).rows.reverse();
    const reference = referenceUrl ? await this.readReferencePage(referenceUrl) : null;
    const brief = await this.tasks.run<DesignBrief>('design_concept_brief', {
      owner_instructions: instructions.slice(0, 4_000),
      lead: {
        source: lead.source,
        title: lead.title,
        description: String(lead.description || '').slice(0, 12_000),
        requirements: lead.requirements,
        analysis: lead.analysis,
      },
      messages: messages.map((message: Record<string, unknown>) => ({
        direction: message.direction,
        author: message.author,
        content: String(message.content || '').slice(0, 3_000),
      })),
      reference,
      policy: {
        concepts_are_preliminary: true,
        do_not_invent_brand_assets: true,
        no_claim_of_customer_approval: true,
      },
    }, 8 * 60_000);
    const count = Math.max(1, Math.min(4, Math.round(requestedCount || 4)));
    const renders = openAiEngine
      ? await this.renderWithOpenAi(apiKey as string, brief.image_prompt, count)
      : await this.renderWithCodex(brief, lead, count);
    if (!renders.length) throw new Error('Генерация не вернула ни одного изображения');
    await this.progress.advance('save', 'Сохраняю изображения', `вариантов ${renders.length}`);
    const generatedRoot = join(this.root, 'design-concepts', leadId);
    await mkdir(generatedRoot, { recursive: true, mode: 0o700 });
    const assets: DesignAsset[] = [];
    for (const [index, render] of renders.entries()) {
      const buffer = render.buffer;
      if (buffer.length < 1_000 || buffer.length > 15 * 1024 * 1024) {
        throw new Error(`Некорректное изображение в варианте ${index + 1}`);
      }
      const id = randomUUID();
      const filePath = join(generatedRoot, `${id}.png`);
      await writeFile(filePath, buffer, { mode: 0o600 });
      await this.db.query(
        `INSERT INTO design_assets(id,lead_id,file_path,content_type,bytes,sha256,metadata)
         VALUES($1,$2,$3,'image/png',$4,$5,$6)`,
        [
          id,
          leadId,
          filePath,
          buffer.length,
          createHash('sha256').update(buffer).digest('hex'),
          JSON.stringify({
            model: render.model,
            quality: IMAGE_QUALITY,
            size: `${MOCKUP_WIDTH}x${MOCKUP_HEIGHT}`,
            variant: index + 1,
            label: render.label,
            title: String(brief.title || '').slice(0, 300),
          }),
        ],
      );
      assets.push({
        id,
        filePath,
        contentType: 'image/png',
        publicUrl: this.publicAssetUrl(id, 30 * 24 * 60 * 60),
      });
    }
    return { brief, assets, estimatedCostUsd: this.estimate(assets.length) };
  }

  publicAssetUrl(id: string, ttlSeconds = 7 * 24 * 60 * 60): string {
    const base = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
    const secret = process.env.ENCRYPTION_KEY;
    if (!base || !secret) throw new Error('PUBLIC_URL или ENCRYPTION_KEY не настроены');
    const expires = Math.floor(Date.now() / 1_000) + Math.max(60, ttlSeconds);
    const signature = createHmac('sha256', secret).update(`${id}.${expires}`).digest('hex');
    return `${base}/api/public/design-assets/${encodeURIComponent(id)}?expires=${expires}&signature=${signature}`;
  }

  async publicAsset(id: string, expiresRaw: string, signature: string) {
    const expires = Number(expiresRaw);
    const secret = process.env.ENCRYPTION_KEY;
    if (!secret || !Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1_000)) {
      throw new Error('Ссылка истекла');
    }
    const expected = createHmac('sha256', secret).update(`${id}.${expires}`).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, 'hex');
    } catch {
      throw new Error('Некорректная подпись');
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Некорректная подпись');
    const asset = (await this.db.query<{ file_path: string; content_type: string }>(
      'SELECT file_path,content_type FROM design_assets WHERE id=$1',
      [id],
    )).rows[0];
    if (!asset) throw new Error('Изображение не найдено');
    const path = resolve(asset.file_path);
    if (!path.startsWith(`${this.root}/`)) throw new Error('Некорректный путь изображения');
    return { path, contentType: asset.content_type || 'image/png' };
  }

  async urls(assetIds: string[], ttlSeconds = 7 * 24 * 60 * 60) {
    const unique = Array.from(new Set(assetIds.map(String))).slice(0, 10);
    if (!unique.length) return [];
    const rows = (await this.db.query<{ id: string }>(
      'SELECT id FROM design_assets WHERE id=ANY($1::uuid[]) ORDER BY created_at',
      [unique],
    )).rows;
    if (rows.length !== unique.length) throw new Error('Часть изображений не найдена');
    const available = new Set(rows.map((row) => row.id));
    return unique.filter((id) => available.has(id)).map((id) => this.publicAssetUrl(id, ttlSeconds));
  }

  /**
   * Codex cannot return a raster, but it writes excellent HTML/CSS. One call per variant
   * keeps a single failure from losing the whole batch and stays well inside the token budget.
   */
  private async renderWithCodex(
    brief: DesignBrief,
    lead: Record<string, unknown>,
    count: number,
  ): Promise<Array<{ buffer: Buffer; label: string; model: string }>> {
    const renders: Array<{ buffer: Buffer; label: string; model: string }> = [];
    const failures: string[] = [];
    for (let variant = 1; variant <= count; variant += 1) {
      try {
        const page = await this.tasks.run<{ label: string; html: string }>('design_concept_html', {
          brief: {
            title: brief.title,
            visual_direction: brief.visual_direction,
            image_prompt: brief.image_prompt,
          },
          lead: {
            source: lead.source,
            title: lead.title,
            description: String(lead.description || '').slice(0, 6_000),
          },
          variant,
          total: count,
          canvas: { width: MOCKUP_WIDTH, height: MOCKUP_HEIGHT },
        }, 8 * 60_000);
        await this.progress.advance('render', 'Рендерю PNG в Chromium', `вариант ${variant} из ${count}`);
        renders.push({
          buffer: await this.renderHtmlToPng(page.html),
          label: String(page.label || `Вариант ${variant}`).slice(0, 200),
          model: 'codex-html',
        });
      } catch (error) {
        failures.push(`вариант ${variant}: ${error instanceof Error ? error.message : 'ошибка'}`);
      }
    }
    if (!renders.length) {
      throw new Error(`Codex не вернул ни одного макета — ${failures.join('; ').slice(0, 400)}`);
    }
    return renders;
  }

  private async renderWithOpenAi(
    apiKey: string,
    prompt: string,
    count: number,
  ): Promise<Array<{ buffer: Buffer; label: string; model: string }>> {
    await this.progress.advance('render', 'Рисую изображения', 'через OpenAI Images');
    const body = await this.callImageApi(apiKey, prompt, count);
    const items = Array.isArray(body.data) ? body.data.slice(0, count) : [];
    return items.map((item: Record<string, unknown>, index: number) => ({
      buffer: Buffer.from(String(item?.b64_json || ''), 'base64'),
      label: `Вариант ${index + 1}`,
      model: IMAGE_MODEL,
    }));
  }

  /**
   * The markup is model-authored, so it is rendered with scripting off and every network
   * request aborted: the page can only lay out what it carries inside itself.
   */
  private async renderHtmlToPng(rawHtml: string): Promise<Buffer> {
    const html = String(rawHtml || '');
    if (html.length < 200) throw new Error('Codex вернул пустую разметку');
    if (html.length > MAX_MOCKUP_HTML) throw new Error('Разметка макета слишком большая');
    const browser = await puppeteer.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const url = request.url();
        if (url.startsWith('data:') || url.startsWith('about:')) request.continue().catch(() => undefined);
        else request.abort().catch(() => undefined);
      });
      await page.setViewport({ width: MOCKUP_WIDTH, height: MOCKUP_HEIGHT, deviceScaleFactor: 1 });
      const encoded = Buffer.from(html, 'utf8').toString('base64');
      await page.goto(`data:text/html;charset=utf-8;base64,${encoded}`, {
        waitUntil: 'load',
        timeout: 30_000,
      });
      const shot = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: MOCKUP_WIDTH, height: MOCKUP_HEIGHT },
      });
      return Buffer.from(shot);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  private async callImageApi(apiKey: string, prompt: string, count: number): Promise<any> {
    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt: String(prompt || '').slice(0, 32_000),
          n: count,
          size: IMAGE_SIZE,
          quality: IMAGE_QUALITY,
          output_format: 'png',
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      throw new Error(`OpenAI не подтвердил результат генерации; автоповтор отключён: ${error instanceof Error ? error.message : 'сетевая ошибка'}`);
    }
    const requestId = response.headers.get('x-request-id') || null;
    const body = await response.json().catch(() => null) as any;
    if (!response.ok) {
      const code = String(body?.error?.code || body?.error?.type || `HTTP ${response.status}`).slice(0, 120);
      throw new Error(`OpenAI Images: ${code}${requestId ? `, request ${requestId}` : ''}`);
    }
    return body;
  }

  private async readReferencePage(value: string) {
    let url = validateReferenceUrlSyntax(value);
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      await this.assertPublicHost(url.hostname);
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; FreelanceSalesDesign/1.0)' },
        signal: AbortSignal.timeout(20_000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirect === 3) throw new Error('Слишком много перенаправлений в ссылке');
        url = validateReferenceUrlSyntax(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new Error(`Ссылка вернула HTTP ${response.status}`);
      const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      if (!['text/html', 'text/plain', 'application/json'].includes(contentType)) {
        throw new Error(`Неподдерживаемый тип ссылки: ${contentType || 'неизвестный'}`);
      }
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > MAX_REFERENCE_BYTES) throw new Error('Страница по ссылке слишком большая');
      const text = await this.readLimitedText(response, MAX_REFERENCE_BYTES);
      if (contentType !== 'text/html') {
        return { url: url.toString(), title: '', description: '', text: text.slice(0, 12_000) };
      }
      const $ = cheerio.load(text);
      $('script,style,noscript,svg').remove();
      const title = ($('meta[property="og:title"]').attr('content') || $('title').text()).trim();
      const description = ($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '').trim();
      const body = $('body').text().replace(/\s+/g, ' ').trim();
      return {
        url: url.toString(),
        title: title.slice(0, 500),
        description: description.slice(0, 2_000),
        text: body.slice(0, 12_000),
      };
    }
    throw new Error('Не удалось прочитать ссылку');
  }

  private async assertPublicHost(hostname: string) {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((item) => isBlockedIpAddress(item.address))) {
      throw new Error('Ссылка ведёт на приватный или недоступный адрес');
    }
  }

  private async readLimitedText(response: Response, limit: number) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('Страница по ссылке слишком большая');
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
