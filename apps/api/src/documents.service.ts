import { Injectable } from '@nestjs/common';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

@Injectable()
export class DocumentsService {
  private readonly root = process.env.DOCUMENTS_DIR || '/app/data/documents';
  private readonly contractTemplate = join(this.root, 'templates', 'contract-template.docx');

  async writeDocx(leadId: string, kind: string, version: number, markdown: string) {
    await mkdir(this.root, { recursive: true });
    const paragraphs = markdown.split('\n').map((line) => {
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
        return new Paragraph({ text: heading[2], heading: levels[heading[1].length - 1] });
      }
      const bullet = line.match(/^[-*]\s+(.+)$/);
      if (bullet) return new Paragraph({ text: bullet[1], bullet: { level: 0 } });
      return new Paragraph({ children: [new TextRun(line)] });
    });
    const doc = new Document({ sections: [{ children: paragraphs }] });
    const path = join(this.root, `${leadId}-${kind}-v${version}.docx`);
    await writeFile(path, await Packer.toBuffer(doc));
    return path;
  }

  async saveContractTemplate(buffer: Buffer) {
    if (buffer.length < 4 || buffer.subarray(0, 2).toString() !== 'PK') throw new Error('Файл не похож на DOCX');
    await mkdir(join(this.root, 'templates'), { recursive: true });
    await writeFile(this.contractTemplate, buffer, { mode: 0o600 });
    return { ok: true };
  }

  async hasContractTemplate() {
    return access(this.contractTemplate).then(() => true).catch(() => false);
  }

  async writeContract(leadId: string, version: number, values: Record<string, unknown>) {
    const source = await readFile(this.contractTemplate);
    const zip = new PizZip(source.toString('binary'));
    const template = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => '',
    });
    const data = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? '']));
    if (typeof data.price === 'number') data.price_formatted = new Intl.NumberFormat('ru-RU').format(data.price);
    template.render(data);
    const path = join(this.root, `${leadId}-contract-v${version}.docx`);
    await writeFile(path, template.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
    return path;
  }
}
