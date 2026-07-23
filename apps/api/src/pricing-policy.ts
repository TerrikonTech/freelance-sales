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
  small_fix: { label: 'Небольшая доработка или исправления', price: [25_000, 40_000, 60_000], days: [2, 4, 7] },
  site_revision: { label: 'Средняя доработка сайта', price: [60_000, 90_000, 120_000], days: [7, 14, 20] },
  technical_seo: { label: 'Техническое SEO с исправлениями', price: [60_000, 90_000, 120_000], days: [7, 10, 14] },
  landing_standard: { label: 'Обычный лендинг', price: [80_000, 80_000, 100_000], days: [10, 14, 18] },
  landing_immersive: { label: 'Иммерсивный лендинг с моушеном', price: [150_000, 150_000, 180_000], days: [17, 21, 28] },
  corporate_standard: { label: 'Обычный корпоративный сайт', price: [150_000, 150_000, 180_000], days: [24, 30, 38] },
  corporate_motion: { label: 'Корпоративный сайт с моушеном', price: [225_000, 225_000, 260_000], days: [35, 45, 55] },
  complex_site: { label: 'Сложный сайт с нестандартной логикой', price: [250_000, 250_000, 300_000], days: [35, 45, 55] },
  complex_site_motion: { label: 'Сложный иммерсивный сайт', price: [350_000, 350_000, 420_000], days: [50, 60, 75] },
  store_simple: { label: 'Простой интернет-магазин', price: [300_000, 300_000, 350_000], days: [35, 45, 55] },
  store_full: { label: 'Полноценный интернет-магазин', price: [400_000, 400_000, 500_000], days: [50, 60, 75] },
  store_complex: { label: 'Сложный магазин с учётом и интеграциями', price: [550_000, 625_000, 700_000], days: [75, 85, 100] },
  account_or_internal_service: { label: 'Личный кабинет или внутренний сервис', price: [250_000, 325_000, 400_000], days: [45, 60, 75] },
  crm_admin_analytics: { label: 'CRM, админка или аналитическая система', price: [300_000, 375_000, 450_000], days: [45, 60, 75] },
  automation_or_bot: { label: 'Бот, автоматизация или интеграционный сервис', price: [100_000, 175_000, 250_000], days: [14, 30, 45] },
  platform_mvp: { label: 'MVP платформы или SaaS', price: [600_000, 600_000, 750_000], days: [75, 90, 110] },
  platform_large: { label: 'Большая платформа', price: [800_000, 1_000_000, 1_200_000], days: [120, 150, 180] },
  mobile_mvp: { label: 'MVP мобильного приложения', price: [500_000, 600_000, 700_000], days: [75, 90, 105] },
  support_monthly: { label: 'Ежемесячная поддержка и развитие', price: [50_000, 75_000, 100_000], days: [30, 30, 30] },
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
    price: roundPrice(price),
    days: Math.max(1, Math.ceil(days)),
  };
}
