export const PRICING_CATEGORIES = [
  'small_fix',
  'site_revision',
  'technical_seo',
  'landing_standard',
  'landing_immersive',
  'corporate_standard',
  'corporate_motion',
  'complex_site',
  'complex_site_motion',
  'store_simple',
  'store_full',
  'store_complex',
  'account_or_internal_service',
  'crm_admin_analytics',
  'automation_or_bot',
  'parsing_scraping',
  'platform_mvp',
  'platform_large',
  'mobile_mvp',
  'support_monthly',
] as const;

export const PRICING_LEVELS = ['low', 'standard', 'high'] as const;

export const PRICING_MODIFIERS = [
  'rush',
  'multilingual',
  'legacy_code',
  'integration_small',
  'integration_medium',
  'integration_large',
] as const;

export type PricingCategory = typeof PRICING_CATEGORIES[number];
export type PricingLevel = typeof PRICING_LEVELS[number];
export type PricingModifier = typeof PRICING_MODIFIERS[number];

type PriceRange = {
  label: string;
  price: [number, number, number];
  days: [number, number, number];
};

export const PRICING_CATALOG: Record<PricingCategory, PriceRange> = {
  // Half an hour of work still costs a whole day of the calendar: the reply, the
  // call and the transfer eat the rest. Quoting 500 ₽ for "правки" loses money on
  // the order and on the time spent winning it.
  small_fix: { label: 'Точечная правка без разработки новой функции', price: [15_000, 25_000, 40_000], days: [1, 2, 4] },
  site_revision: { label: 'Средняя доработка сайта', price: [40_000, 60_000, 90_000], days: [4, 7, 12] },
  technical_seo: { label: 'Техническое SEO с исправлениями', price: [40_000, 70_000, 100_000], days: [5, 10, 14] },
  landing_standard: { label: 'Обычный лендинг', price: [80_000, 80_000, 100_000], days: [10, 14, 18] },
  landing_immersive: { label: 'Иммерсивный лендинг с моушеном', price: [140_000, 170_000, 220_000], days: [17, 21, 28] },
  corporate_standard: { label: 'Обычный корпоративный сайт', price: [150_000, 200_000, 250_000], days: [24, 30, 38] },
  corporate_motion: { label: 'Корпоративный сайт с моушеном', price: [225_000, 260_000, 320_000], days: [35, 45, 55] },
  complex_site: { label: 'Сложный сайт с нестандартной логикой', price: [250_000, 300_000, 380_000], days: [35, 45, 55] },
  complex_site_motion: { label: 'Сложный иммерсивный сайт', price: [350_000, 400_000, 480_000], days: [50, 60, 75] },
  store_simple: { label: 'Простой интернет-магазин', price: [300_000, 300_000, 350_000], days: [35, 45, 55] },
  store_full: { label: 'Полноценный интернет-магазин', price: [400_000, 400_000, 500_000], days: [50, 60, 75] },
  store_complex: { label: 'Сложный магазин с учётом и интеграциями', price: [550_000, 625_000, 700_000], days: [75, 85, 100] },
  account_or_internal_service: { label: 'Личный кабинет или внутренний сервис', price: [250_000, 325_000, 400_000], days: [45, 60, 75] },
  crm_admin_analytics: { label: 'CRM, админка или аналитическая система', price: [300_000, 375_000, 450_000], days: [45, 60, 75] },
  // Calibrated against comparable FL.ru bot projects: a shared bot core should not
  // inherit agency/platform pricing merely because the brief mentions two channels.
  automation_or_bot: { label: 'Бот, автоматизация или интеграционный сервис', price: [60_000, 110_000, 180_000], days: [7, 16, 28] },
  // Parsing market 2025: a one-off scrape starts near 10-25k, a scheduled parser
  // sits around 60k, a multi-source monitored setup reaches 100-120k.
  parsing_scraping: { label: 'Парсинг и сбор данных', price: [25_000, 60_000, 120_000], days: [3, 7, 14] },
  platform_mvp: { label: 'MVP платформы или SaaS', price: [600_000, 600_000, 750_000], days: [75, 90, 110] },
  platform_large: { label: 'Большая платформа', price: [800_000, 1_000_000, 1_200_000], days: [120, 150, 180] },
  mobile_mvp: { label: 'MVP мобильного приложения', price: [250_000, 300_000, 350_000], days: [35, 45, 60] },
  support_monthly: { label: 'Ежемесячная поддержка и развитие', price: [30_000, 55_000, 85_000], days: [30, 30, 30] },
};

export const DEFAULT_PRICING_POLICY = {
  currency: 'RUB',
  positioning: 'Верхний ценовой сегмент: сильный самостоятельный разработчик с 6-летним опытом и бэкграундом Яндекса',
  categories: Object.fromEntries(
    Object.entries(PRICING_CATALOG).map(([key, value]) => [key, {
      label: value.label,
      price_rub: value.price,
      days: value.days,
    }]),
  ),
  levels: {
    low: 'Узкий, хорошо определённый объём без скрытых подсистем',
    standard: 'Типовой для категории полный объём',
    high: 'Верхняя граница категории: много экранов, ролей, состояний или плотная бизнес-логика',
  },
  modifiers: {
    rush: '+25% к цене, срок примерно -20%',
    multilingual: '+15% к цене и +10% к сроку',
    legacy_code: '+15% к цене и сроку только после подтверждения аудитом',
    integration_small: '+50 000 ₽ и около 5 дней',
    integration_medium: '+100 000 ₽ и около 10 дней',
    integration_large: '+150 000 ₽ и около 20 дней',
  },
  rules: [
    'Выбери ровно одну ближайшую категорию и уровень по фактическому объёму, а не по бюджету клиента.',
    'Не складывай похожие категории. Моушен и сложные интеграции, уже определяющие категорию, второй раз модификатором не учитывай.',
    'Применяй модификатор только при явном подтверждении в описании или вложениях; неизвестное выноси в вопросы.',
    'Цены — ориентиры верхнего сегмента, а не жёсткий прайс. Клиенту всегда показывается одна итоговая цена и один срок без пакетов.',
    'Статистика конкурентов — только проверка здравого смысла. Она не снижает цену и сама по себе не меняет расчёт.',
    'Контент, фото, видео, платные лицензии и сервисы оцениваются отдельно, если их производство прямо не включено в задачу.',
  ],
};

export type PricingInput = {
  category: unknown;
  level: unknown;
  modifiers: unknown;
  estimatedDays: unknown;
};

export type PricingResult = {
  category: PricingCategory;
  label: string;
  level: PricingLevel;
  modifiers: PricingModifier[];
  price: number;
  days: number;
};

function isCategory(value: unknown): value is PricingCategory {
  return typeof value === 'string' && (PRICING_CATEGORIES as readonly string[]).includes(value);
}

function isLevel(value: unknown): value is PricingLevel {
  return typeof value === 'string' && (PRICING_LEVELS as readonly string[]).includes(value);
}

function normalizeModifiers(value: unknown): PricingModifier[] {
  if (!Array.isArray(value)) return [];
  const valid = [...new Set(value.filter(
    (item): item is PricingModifier => typeof item === 'string' && (PRICING_MODIFIERS as readonly string[]).includes(item),
  ))];
  const integrations = ['integration_small', 'integration_medium', 'integration_large'] as const;
  const selectedIntegration = [...integrations].reverse().find((item) => valid.includes(item));
  return valid.filter((item) => !integrations.includes(item as typeof integrations[number]) || item === selectedIntegration);
}

function roundPrice(value: number): number {
  return Math.ceil(value / 5_000) * 5_000;
}

export function calculateCatalogPrice(input: PricingInput): PricingResult | null {
  if (!isCategory(input.category)) return null;
  const category = input.category;
  const level = isLevel(input.level) ? input.level : 'standard';
  const levelIndex = PRICING_LEVELS.indexOf(level);
  const entry = PRICING_CATALOG[category];
  const modifiers = normalizeModifiers(input.modifiers);
  const estimatedDays = Math.max(1, Math.round(Number(input.estimatedDays) || entry.days[levelIndex]));
  let days = Math.min(entry.days[2], Math.max(entry.days[0], estimatedDays));
  let price = entry.price[levelIndex];

  const integration = modifiers.find((item) => item.startsWith('integration_'));
  if (integration === 'integration_small') {
    price += 50_000;
    days += 5;
  } else if (integration === 'integration_medium') {
    price += 100_000;
    days += 10;
  } else if (integration === 'integration_large') {
    price += 150_000;
    days += 20;
  }
  if (modifiers.includes('multilingual')) {
    price *= 1.15;
    days *= 1.1;
  }
  if (modifiers.includes('legacy_code')) {
    price *= 1.15;
    days *= 1.15;
  }
  if (modifiers.includes('rush')) {
    price *= 1.25;
    days *= 0.8;
  }

  return {
    category,
    label: entry.label,
    level,
    modifiers,
    price: Math.max(MIN_QUOTE_PRICE_RUB, category === 'small_fix' ? Math.ceil(price / 500) * 500 : roundPrice(price)),
    days: Math.max(1, Math.ceil(days)),
  };
}

/**
 * The catalogue answers "what does a project like this usually cost", which is a
 * different question from "what does THIS project cost".  Across 1933 analysed leads
 * it produced 47 distinct prices: the number was being picked off a menu, so a video
 * pipeline with three publishing targets got the same 110 000 ₽ as a three-screen bot.
 * A quote built from the actual list of work moves with the work.
 */
export type WorkItem = {
  what: unknown;
  days_optimistic: unknown;
  days_realistic: unknown;
  days_pessimistic: unknown;
};

export type BottomUpResult = {
  price: number;
  days: number;
  priceLow: number;
  priceHigh: number;
  daysLow: number;
  daysHigh: number;
  itemCount: number;
  dailyRate: number;
};

/**
 * Derived from the owner's own catalogue: corporate_standard is 150 000 ₽ for 30 days,
 * crm_admin_analytics 375 000 for 60, store_full 400 000 for 60.  The median day is
 * worth about this much, so bottom-up quotes stay on the same scale as the old ones
 * instead of silently repricing every category.
 */
export const DEFAULT_DAILY_RATE_RUB = 6_250;

/** Below this an order costs more to win than it pays: no draft, no reply. */
export const DEFAULT_MIN_DEAL_PRICE_RUB = 30_000;

/** A quote under this reads as a joke even when the task is genuinely tiny. */
export const MIN_QUOTE_PRICE_RUB = 10_000;

/**
 * Order size is read straight off the fair price instead of another model
 * opinion: the same order must always land in the same bucket.
 */
export type SizeGrade = 'small' | 'medium' | 'large';

export const SIZE_GRADE_THRESHOLDS = {
  mediumFrom: 100_000,
  largeFrom: 300_000,
} as const;

export function sizeGrade(priceRub: number): SizeGrade {
  const value = Number(priceRub);
  if (!Number.isFinite(value) || value < SIZE_GRADE_THRESHOLDS.mediumFrom) return 'small';
  if (value < SIZE_GRADE_THRESHOLDS.largeFrom) return 'medium';
  return 'large';
}

/**
 * A named fixed budget far below the fair price is a trap: the letter would
 * quietly commit to a ten-times-too-cheap deal. The ratio (fair ÷ named) is
 * the single number both the flag and the owner alert are built on.
 */
export const UNDERPRICED_RATIO = 2.5;

export function underpricingRatio(fairPrice: number, namedBudget: number): number | null {
  const fair = Number(fairPrice);
  const named = Number(namedBudget);
  if (!Number.isFinite(fair) || fair <= 0 || !Number.isFinite(named) || named <= 0) return null;
  return Number((fair / named).toFixed(2));
}

export function isUnderpriced(fairPrice: number, namedBudget: number): boolean {
  const ratio = underpricingRatio(fairPrice, namedBudget);
  return ratio !== null && ratio >= UNDERPRICED_RATIO;
}

/**
 * How much an order is worth to the business, 0…100. Scoring used to rank a
 * favicon level with a 245 000 ₽ site because fit was the only thing measured;
 * this puts the money back into the ranking.
 */
export function dealValueScore(priceRub: number): number {
  const points: Array<[number, number]> = [
    [15_000, 0],
    [30_000, 35],
    [60_000, 60],
    [150_000, 85],
    [300_000, 100],
  ];
  const value = Number(priceRub);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value <= points[0][0]) return 0;
  if (value >= points[points.length - 1][0]) return 100;
  for (let index = 1; index < points.length; index += 1) {
    const [highPrice, highScore] = points[index];
    const [lowPrice, lowScore] = points[index - 1];
    if (value <= highPrice) {
      const ratio = (value - lowPrice) / (highPrice - lowPrice);
      return Math.round(lowScore + ratio * (highScore - lowScore));
    }
  }
  return 100;
}

/** Nobody delivers 40 days of work without a single day of coordination or fixes. */
const OVERHEAD = 1.15;

export function calculateBottomUpPrice(
  breakdown: unknown,
  dailyRate = DEFAULT_DAILY_RATE_RUB,
): BottomUpResult | null {
  if (!Array.isArray(breakdown) || !breakdown.length) return null;
  const rate = Number(dailyRate) > 0 ? Number(dailyRate) : DEFAULT_DAILY_RATE_RUB;
  let optimistic = 0;
  let realistic = 0;
  let pessimistic = 0;
  let itemCount = 0;
  for (const entry of breakdown) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as WorkItem;
    const mid = Number(item.days_realistic);
    if (!Number.isFinite(mid) || mid <= 0 || mid > 200) continue;
    const low = Number(item.days_optimistic);
    const high = Number(item.days_pessimistic);
    realistic += mid;
    optimistic += Number.isFinite(low) && low > 0 && low <= mid ? low : mid * 0.75;
    pessimistic += Number.isFinite(high) && high >= mid && high <= 400 ? high : mid * 1.4;
    itemCount += 1;
  }
  if (!itemCount) return null;
  const toDays = (value: number) => Math.max(1, Math.ceil(value * OVERHEAD));
  const toPrice = (value: number) => Math.ceil((value * OVERHEAD * rate) / 5_000) * 5_000;
  return {
    price: Math.max(MIN_QUOTE_PRICE_RUB, toPrice(realistic)),
    days: toDays(realistic),
    priceLow: toPrice(optimistic),
    priceHigh: toPrice(pessimistic),
    daysLow: toDays(optimistic),
    daysHigh: toDays(pessimistic),
    itemCount,
    dailyRate: rate,
  };
}

/**
 * The buyer is quoted what the work actually costs: the bottom-up list is the
 * price source and the catalogue keeps it inside a believable corridor. Inside
 * the corridor the breakdown wins, because the catalogue only knows the
 * category while the breakdown knows the work. Below the corridor the catalogue
 * speaks: a worklist that cheap usually describes a different job (retainer,
 * design, non-development scope). Above it the catalogue caps the quote, so an
 * over-detailed breakdown cannot triple an ordinary order.
 */
export const CORRIDOR_LOW_RATIO = 0.6;
export const CORRIDOR_HIGH_RATIO = 1.3;

export type EstimateSource = 'breakdown' | 'catalog' | 'corridor_capped';

export type EstimateReconciliation = {
  price: number;
  days: number;
  source: EstimateSource;
  gap: number | null;
};

export function reconcileEstimate(
  bottomUp: BottomUpResult | null,
  catalog: PricingResult | null,
): EstimateReconciliation {
  if (!bottomUp) {
    return catalog
      ? { price: catalog.price, days: catalog.days, source: 'catalog', gap: null }
      : { price: 0, days: 0, source: 'catalog', gap: null };
  }
  if (!catalog) return { price: bottomUp.price, days: bottomUp.days, source: 'breakdown', gap: null };
  const gap = Number((bottomUp.price / Math.max(1, catalog.price)).toFixed(2));
  if (gap < CORRIDOR_LOW_RATIO) {
    return { price: catalog.price, days: catalog.days, source: 'catalog', gap };
  }
  if (gap > CORRIDOR_HIGH_RATIO) {
    const price = roundPrice(catalog.price * CORRIDOR_HIGH_RATIO);
    // The term is cut by the same factor as the price, so a capped quote still
    // reads as the owner's daily rate instead of twelve days for twenty thousand.
    const days = Math.max(1, Math.round(bottomUp.days * (price / Math.max(1, bottomUp.price))));
    return { price, days, source: 'corridor_capped', gap };
  }
  return { price: bottomUp.price, days: bottomUp.days, source: 'breakdown', gap };
}
