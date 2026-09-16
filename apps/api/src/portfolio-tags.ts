import { readFileSync, statSync } from 'node:fs';

/**
 * Owner-editable tags for the FL portfolio cases. Without them the picker only had
 * titles and descriptions to compare, so a parser brief matched MES LITE on the word
 * "данные". Tags live in a JSON file next to the prompts: editing them needs no rebuild.
 *
 * Shape: { "<portfolio id>": { job_types: [...PRICING_CATEGORIES], stack, domain, facts } }
 */
export type PortfolioCaseTags = {
  job_types: string[];
  stack: string;
  domain: string;
  facts: string[];
};

const TAGS_PATH = process.env.PORTFOLIO_TAGS_PATH || '/app/prompts/portfolio_case_tags.json';
let cache: { mtimeMs: number; value: Record<string, PortfolioCaseTags> } | null = null;

export function loadPortfolioCaseTags(): Record<string, PortfolioCaseTags> {
  try {
    const stat = statSync(TAGS_PATH);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.value;
    const parsed = JSON.parse(readFileSync(TAGS_PATH, 'utf8')) as Record<string, unknown>;
    const value: Record<string, PortfolioCaseTags> = {};
    for (const [key, raw] of Object.entries(parsed || {})) {
      const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      value[String(key)] = {
        job_types: Array.isArray(row.job_types) ? row.job_types.map(String).filter(Boolean).slice(0, 3) : [],
        stack: String(row.stack || '').slice(0, 160),
        domain: String(row.domain || '').slice(0, 80),
        facts: Array.isArray(row.facts)
          ? row.facts.map(String).map((fact) => fact.slice(0, 200)).filter(Boolean).slice(0, 3)
          : [],
      };
    }
    cache = { mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    return cache?.value || {};
  }
}

/** The FL portfolio URL ends with the case number, which survives re-syncs; titles do not. */
export function portfolioCaseKey(url: unknown): string {
  const match = String(url || '').match(/\/portfolio\/(\d+)/iu);
  return match ? match[1] : '';
}

/**
 * Types of the current order. The analyzer already names one PRICING_CATEGORY; the
 * wording hints only widen the net for the rare lead the analyzer left without one.
 */
const LEAD_TYPE_HINTS: Array<{ type: string; pattern: RegExp }> = [
  { type: 'parsing_scraping', pattern: /(?:парс|scrap|сбор\s+данн|выгрузк|мониторинг\s+цен|отслежив|слежен)/iu },
  { type: 'automation_or_bot', pattern: /(?:telegram|телеграм|бот|aiogram|n8n|вебхук|webhook|автоматизац|интеграц)/iu },
  { type: 'store_full', pattern: /(?:интернет[-\s]?магазин|маркетплейс|woocommerce|корзин|каталог\s+товар)/iu },
  { type: 'landing_standard', pattern: /(?:лендинг|landing|одностранич|посадочн)/iu },
  { type: 'corporate_standard', pattern: /(?:корпоративн|сайт\s+компани|многостраничн)/iu },
  { type: 'crm_admin_analytics', pattern: /(?:crm|админк|дашборд|аналитич|отч[ёе]т|панель\s+управлен)/iu },
  { type: 'account_or_internal_service', pattern: /(?:личн\w*\s+кабинет|внутренн\w*\s+сервис|портал|платформ)/iu },
  { type: 'mobile_mvp', pattern: /(?:мобильн\w*\s+приложен|ios|android|flutter|react\s+native)/iu },
  { type: 'technical_seo', pattern: /(?:seo|поисков\w*\s+оптимизац)/iu },
  { type: 'site_revision', pattern: /(?:доработ|правк|исправить|поправить|обновить|перенести|допилить|доделать)/iu },
  { type: 'small_fix', pattern: /(?:мелк|точечн|поменять)/iu },
  { type: 'support_monthly', pattern: /(?:поддержк|сопровожден|абонентск|регулярн)/iu },
];

export function leadCaseTypes(analysis: unknown, leadText = ''): string[] {
  const row = analysis && typeof analysis === 'object' ? analysis as Record<string, unknown> : {};
  const types: string[] = [];
  const category = String(row.pricing_category || '').trim();
  if (category) types.push(category);
  for (const hint of LEAD_TYPE_HINTS) {
    if (hint.pattern.test(leadText) && !types.includes(hint.type)) types.push(hint.type);
  }
  return types.slice(0, 8);
}
