import {
  calculateBottomUpPrice,
  calculateCatalogPrice,
  CORRIDOR_HIGH_RATIO,
  CORRIDOR_LOW_RATIO,
  DEFAULT_DAILY_RATE_RUB,
  reconcileEstimate,
} from './pricing-policy';
import { proposalOffersOptions, proposalProfileForLead } from './ai.service';

/** The AI video pipeline the catalogue priced at 110 000 ₽ for 16 days. */
const VIDEO_PIPELINE = [
  { what: 'Приём исходного видео и очередь обработки', days_optimistic: 3, days_realistic: 4, days_pessimistic: 6 },
  { what: 'Транскрибация с таймкодами', days_optimistic: 2, days_realistic: 3, days_pessimistic: 5 },
  { what: 'Монтажный лист, вырезание пауз, вертикальный рендер', days_optimistic: 6, days_realistic: 9, days_pessimistic: 14 },
  { what: 'Субтитры и обложки', days_optimistic: 3, days_realistic: 4, days_pessimistic: 6 },
  { what: 'Редактор текстов на базе Claude с контекстом владельца', days_optimistic: 4, days_realistic: 6, days_pessimistic: 9 },
  { what: 'Интерфейс согласования', days_optimistic: 4, days_realistic: 6, days_pessimistic: 8 },
  { what: 'Публикация в Telegram, YouTube Shorts и соцсеть', days_optimistic: 5, days_realistic: 7, days_pessimistic: 11 },
];

describe('bottom-up estimate', () => {
  test('a real list of work prices far above the catalogue median for the same category', () => {
    const breakdown = calculateBottomUpPrice(VIDEO_PIPELINE)!;
    const catalog = calculateCatalogPrice({
      category: 'automation_or_bot', level: 'standard', modifiers: [], estimatedDays: 16,
    })!;

    expect(catalog.price).toBe(110_000);
    expect(breakdown.days).toBeGreaterThan(catalog.days * 2);
    // 285 000 ₽ against the catalogue's 110 000: the same brief, priced by its work.
    expect(breakdown.price).toBeGreaterThan(catalog.price * 2.5);
    expect(breakdown.priceLow).toBeLessThan(breakdown.price);
    expect(breakdown.priceHigh).toBeGreaterThan(breakdown.price);
    expect(breakdown.itemCount).toBe(7);
  });

  test('the price moves with the work instead of snapping to a menu value', () => {
    const small = calculateBottomUpPrice([
      { what: 'Одна форма', days_optimistic: 1, days_realistic: 2, days_pessimistic: 3 },
    ])!;
    const large = calculateBottomUpPrice(VIDEO_PIPELINE)!;
    expect(small.price).toBeLessThan(large.price / 10);
    expect(small.price % 5_000).toBe(0);
  });

  test('missing or absurd day counts never become a quote', () => {
    expect(calculateBottomUpPrice([])).toBeNull();
    expect(calculateBottomUpPrice('шесть дней')).toBeNull();
    expect(calculateBottomUpPrice([{ what: 'x', days_realistic: 0, days_optimistic: 0, days_pessimistic: 0 }])).toBeNull();
    expect(calculateBottomUpPrice([{ what: 'x', days_realistic: 9_000, days_optimistic: 1, days_pessimistic: 2 }])).toBeNull();
  });

  test('a broken optimistic bound is repaired rather than trusted', () => {
    const result = calculateBottomUpPrice([
      { what: 'Работа', days_optimistic: 40, days_realistic: 10, days_pessimistic: 2 },
    ])!;
    expect(result.daysLow).toBeLessThanOrEqual(result.days);
    expect(result.daysHigh).toBeGreaterThanOrEqual(result.days);
  });

  test('the rate comes from the owner profile when it is set', () => {
    const cheap = calculateBottomUpPrice(VIDEO_PIPELINE, 3_000)!;
    const standard = calculateBottomUpPrice(VIDEO_PIPELINE, DEFAULT_DAILY_RATE_RUB)!;
    expect(cheap.price).toBeLessThan(standard.price);
    expect(cheap.days).toBe(standard.days);
  });
});

describe('reconciling the breakdown with the catalogue', () => {
  const catalog = calculateCatalogPrice({
    category: 'automation_or_bot', level: 'standard', modifiers: [], estimatedDays: 16,
  });

  test('a breakdown inside the corridor prices the actual list of work', () => {
    const breakdown = calculateBottomUpPrice([
      { what: 'Бот', days_optimistic: 10, days_realistic: 14, days_pessimistic: 20 },
    ]);
    const result = reconcileEstimate(breakdown, catalog);
    expect(result.source).toBe('breakdown');
    expect(result.price).toBe(breakdown!.price);
    expect(result.days).toBe(breakdown!.days);
    expect(result.gap).toBeCloseTo(breakdown!.price / catalog!.price, 2);
  });

  test('a breakdown far above the catalogue is capped by the corridor', () => {
    const breakdown = calculateBottomUpPrice([
      { what: 'Огромный объём', days_optimistic: 60, days_realistic: 90, days_pessimistic: 120 },
    ]);
    const result = reconcileEstimate(breakdown, catalog);
    expect(result.source).toBe('corridor_capped');
    expect(result.price).toBe(145_000);
    expect(result.days).toBeGreaterThan(0);
    expect(result.days).toBeLessThan(breakdown!.days);
    expect(result.gap).toBeGreaterThan(CORRIDOR_HIGH_RATIO);
  });

  test('a breakdown far below the catalogue hands the answer back to the catalogue', () => {
    const breakdown = calculateBottomUpPrice([
      { what: 'Точечная правка', days_optimistic: 1, days_realistic: 1, days_pessimistic: 2 },
    ]);
    const result = reconcileEstimate(breakdown, catalog);
    expect(result.source).toBe('catalog');
    expect(result.price).toBe(catalog!.price);
    expect(result.gap).toBeLessThan(CORRIDOR_LOW_RATIO);
  });

  test('no breakdown at all still yields the old catalogue answer', () => {
    const result = reconcileEstimate(null, catalog);
    expect(result.source).toBe('catalog');
    expect(result.price).toBe(110_000);
  });
});

describe('offering a cheap path alongside the proper one', () => {
  const wiringLead = {
    title: 'Настроить AI контент конвейер',
    description: 'Нужен конвейер: видео попадает в папку, AI режет и публикует в Telegram и Shorts после моего согласования.'.repeat(3),
    recommended_price: 190_000,
    analysis: {
      work_breakdown: Array.from({ length: 8 }, (_, index) => ({ what: `работа ${index}`, days_realistic: 3 })),
      price_range: [130_000, 310_000],
    },
  };

  test('a wiring-style brief with many pieces earns the room to show both paths', () => {
    expect(proposalOffersOptions(wiringLead)).toBe(true);
    expect(proposalProfileForLead(wiringLead)).toBe('premium');
  });

  test('a narrow brief keeps the short format', () => {
    const narrow = {
      ...wiringLead,
      analysis: { work_breakdown: [{ what: 'одна правка', days_realistic: 1 }], price_range: [50_000, 60_000] },
    };
    expect(proposalOffersOptions(narrow)).toBe(false);
    expect(proposalProfileForLead(narrow)).toBe('standard');
  });

  test('a tight estimate has nothing to trade away, so no options are offered', () => {
    const tight = { ...wiringLead, analysis: { ...wiringLead.analysis, price_range: [180_000, 200_000] } };
    expect(proposalOffersOptions(tight)).toBe(false);
  });

  test('a design brief is not something you assemble from services', () => {
    const design = {
      ...wiringLead,
      title: 'Разработка дизайна упаковки',
      description: 'Нужна серия обечаек для нового бренда, отрисовка макетов и подготовка к печати.'.repeat(3),
    };
    expect(proposalOffersOptions(design)).toBe(false);
  });
});
