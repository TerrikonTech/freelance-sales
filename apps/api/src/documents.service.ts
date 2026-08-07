import { Injectable } from '@nestjs/common';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CONTRACT_TAGS = [
  'contract_number',
  'contract_date',
  'customer_name',
  'customer_representative',
  'customer_basis',
  'customer_contact_name',
  'customer_phone',
  'customer_email',
  'days',
  'days_words',
  'price_formatted',
  'price_words',
  'advance_percent',
  'balance_percent',
  'customer_inn',
  'customer_ogrn',
  'customer_signer',
] as const;

const PLAIN_CONTRACT_REPLACEMENTS: Array<[string, string]> = [
  ['ДОГОВОР № ______', 'ДОГОВОР № {contract_number}'],
  ['«___» __________ 20___ г.', '{contract_date}'],
  [
    'и _____________________________, именуемый в дальнейшем «Заказчик», в лице _____________________________, действующего на основании __________________,',
    'и {customer_name}, именуемый в дальнейшем «Заказчик», в лице {customer_representative}, действующего на основании {customer_basis},',
  ],
  [
    'Контактные данные представителя Заказчика: ФИО __________________, телефон __________________, e-mail __________________.',
    'Контактные данные представителя Заказчика: ФИО {customer_contact_name}, телефон {customer_phone}, e-mail {customer_email}.',
  ],
  ['составляет ______ (____________) рабочих дней', 'составляет {days} ({days_words}) рабочих дней'],
  ['составляет ____________ (____________) рублей', 'составляет {price_formatted} ({price_words}) рублей'],
  ['авансовый платёж 50%', 'авансовый платёж {advance_percent}%'],
  ['оставшиеся 50%', 'оставшиеся {balance_percent}%'],
  ['Наименование / ФИО: _____________________________', 'Наименование / ФИО: {customer_name}'],
  ['ИНН: ____________ ОГРН(ИП): ____________', 'ИНН: {customer_inn} ОГРН(ИП): {customer_ogrn}'],
  ['Телефон: __________________', 'Телефон: {customer_phone}'],
  ['E-mail: __________________', 'E-mail: {customer_email}'],
  ['Подпись: ____________ / __________________ /', 'Подпись: ____________ / {customer_signer} /'],
];

function integerValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const normalized = typeof value === 'string' ? value.replace(/\s/g, '') : value;
  if (normalized === '') return null;
  const parsed = typeof normalized === 'number' ? normalized : Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function ruIntegerWords(value: unknown): string {
  const number = integerValue(value);
  if (number === null) return '';
  if (number === 0) return 'ноль';
  const unitsMale = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const unitsFemale = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const teens = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
  const tens = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
  const hundreds = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
  const scales = [
    null,
    { forms: ['тысяча', 'тысячи', 'тысяч'], female: true },
    { forms: ['миллион', 'миллиона', 'миллионов'], female: false },
    { forms: ['миллиард', 'миллиарда', 'миллиардов'], female: false },
  ] as const;
  const chunks: number[] = [];
  for (let remaining = number; remaining > 0; remaining = Math.floor(remaining / 1000)) chunks.push(remaining % 1000);
  const result: string[] = [];
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    if (!chunk) continue;
    result.push(hundreds[Math.floor(chunk / 100)]);
    const lastTwo = chunk % 100;
    if (lastTwo >= 10 && lastTwo <= 19) result.push(teens[lastTwo - 10]);
    else {
      result.push(tens[Math.floor(lastTwo / 10)]);
      result.push((scales[index]?.female ? unitsFemale : unitsMale)[lastTwo % 10]);
    }
    const scale = scales[index];
    if (scale) {
      const last = chunk % 10;
      const form = lastTwo >= 11 && lastTwo <= 19 ? 2 : last === 1 ? 0 : last >= 2 && last <= 4 ? 1 : 2;
      result.push(scale.forms[form]);
    }
  }
  return result.filter(Boolean).join(' ');
}

export function prepareContractTemplateXml(source: string) {
  let xml = source;
  for (const [plain, tagged] of PLAIN_CONTRACT_REPLACEMENTS) {
    if (!xml.includes(tagged)) xml = xml.replace(plain, tagged);
  }
  const missing = CONTRACT_TAGS.filter((tag) => !xml.includes(`{${tag}}`));
  return { xml, missing };
}

export function buildContractTemplateData(values: Record<string, unknown>) {
  const price = integerValue(values.price);
  const days = integerValue(values.days);
  const advance = integerValue(values.advance_percent) ?? 50;
  const status = String(values.customer_status || '').trim();
  const rawName = String(values.customer_name || '').trim();
  const customerName = status && rawName && !rawName.toLocaleLowerCase('ru-RU').startsWith(status.toLocaleLowerCase('ru-RU'))
    ? `${status} ${rawName}`
    : rawName;
  const representative = String(values.customer_representative || '').trim();
  return {
    ...values,
    contract_number: String(values.contract_number || '').trim() || '______',
    contract_date: String(values.contract_date || '').trim() || '«___» __________ 20___ г.',
    customer_name: customerName || '_____________________________',
    customer_representative: representative || '_____________________________',
    customer_basis: String(values.customer_basis || '').trim() || '__________________',
    customer_contact_name: String(values.customer_contact_name || '').trim() || representative || '__________________',
    customer_phone: String(values.customer_phone || '').trim() || '__________________',
    customer_email: String(values.customer_email || '').trim() || '__________________',
    days: days ?? '______',
    days_words: days === null ? '____________' : ruIntegerWords(days),
    price_formatted: price === null ? '____________' : new Intl.NumberFormat('ru-RU').format(price),
    price_words: price === null ? '____________' : ruIntegerWords(price),
    advance_percent: Math.min(100, advance),
    balance_percent: Math.max(0, 100 - Math.min(100, advance)),
    customer_inn: String(values.customer_inn || '').trim() || '____________',
    customer_ogrn: String(values.customer_ogrn || '').trim() || '____________',
    customer_signer: String(values.customer_signer || '').trim() || representative || '__________________',
  };
}

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
    await writeFile(path, await Packer.toBuffer(doc), { mode: 0o600 });
    return path;
  }

  async saveContractTemplate(buffer: Buffer) {
    if (buffer.length < 4 || buffer.subarray(0, 2).toString() !== 'PK') throw new Error('Файл не похож на DOCX');
    let zip: PizZip;
    try {
      zip = new PizZip(buffer.toString('binary'));
    } catch {
      throw new Error('DOCX повреждён или имеет неподдерживаемую структуру');
    }
    const document = zip.file('word/document.xml');
    if (!document) throw new Error('В DOCX не найден основной текст документа');
    const prepared = prepareContractTemplateXml(document.asText());
    if (prepared.missing.length) {
      throw new Error(`Не удалось найти поля шаблона: ${prepared.missing.join(', ')}`);
    }
    zip.file('word/document.xml', prepared.xml);
    await mkdir(join(this.root, 'templates'), { recursive: true });
    await writeFile(this.contractTemplate, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }), { mode: 0o600 });
    return { ok: true, fields: CONTRACT_TAGS.length };
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
    const data = buildContractTemplateData(values);
    template.render(data);
    const path = join(this.root, `${leadId}-contract-v${version}.docx`);
    await writeFile(path, template.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }), { mode: 0o600 });
    return path;
  }
}
