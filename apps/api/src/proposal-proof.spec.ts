import {
  caseConcreteDetails,
  caseOneLiner,
  proposalOpeningPlan,
  PROPOSAL_BANNED_OPENINGS,
  selectRelevantPortfolio,
} from './ai.service';

/** Shaped like the owner's real FL.ru portfolio: rich description, empty structured fields. */
const terraMarket = {
  title: 'TERRA MARKET - маркетплейс фермерских продуктов',
  url: 'https://www.fl.ru/user/sporyshevsaveli/portfolio/8057737/',
  description: 'Разработал fullstack-концепт маркетплейса на Next.js + NestJS. Спроектировал механику работы платформы для покупателей, фермеров и администраторов: добавление товаров, управление остатками, категории, фильтры и рейтинги. Коротко. Отдельно проработал логику каталога: фильтрация по цене, рейтингу, фермеру, региону и срокам доставки.',
  task: '', stack: '', result: '', challenge: '', solution_details: '', client_context: '',
};

describe('portfolio proof material', () => {
  test('the one-liner drops the brand and keeps what the project actually is', () => {
    expect(caseOneLiner(terraMarket)).toBe('маркетплейс фермерских продуктов');
  });

  test('a title without a brand separator falls back to the first sentence', () => {
    expect(caseOneLiner({ title: 'COURIER OS', description: 'Сервис курьерской доставки с картой и статусами. Ещё текст.' }))
      .toBe('Сервис курьерской доставки с картой и статусами.');
  });

  test('concrete details are quotable lines, not the whole description', () => {
    const details = caseConcreteDetails(terraMarket);
    expect(details.length).toBeGreaterThan(0);
    expect(details.join(' ')).toContain('фильтр');
    // Too short to prove anything gets dropped.
    expect(details.some((line) => line === 'Коротко.')).toBe(false);
    expect(details.every((line) => line.length <= 240)).toBe(true);
  });

  test('structured fields win over the description when the owner fills them in', () => {
    const details = caseConcreteDetails({ ...terraMarket, result: 'Каталог на 12 000 товаров начал отдавать остатки без ручной выгрузки.' });
    expect(details[0]).toContain('12 000');
  });

  test('a case with no concrete line yields nothing instead of filler', () => {
    expect(caseConcreteDetails({ description: 'Сделал сайт. Красиво.' })).toEqual([]);
  });

  test('selected cases carry the proof material through to the payload', () => {
    const [best] = selectRelevantPortfolio([terraMarket], 'нужен маркетплейс с каталогом и фильтрами');
    expect(best.what_it_is).toBe('маркетплейс фермерских продуктов');
    expect(Array.isArray(best.concrete_details)).toBe(true);
    expect(best.url).toBe(terraMarket.url);
  });
});

describe('opening plan', () => {
  test('reciting the brief back is banned outright', () => {
    expect(PROPOSAL_BANNED_OPENINGS).toContain('у вас в задаче');
    expect(PROPOSAL_BANNED_OPENINGS).toContain('я внимательно прочитал');
  });

  test('the angle rotates with the lead instead of being one fixed phrase', () => {
    const angles = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
      .map((seed) => proposalOpeningPlan(seed).angle));
    expect(angles.size).toBeGreaterThan(1);
  });

  test('every angle tells the writer where to start, never what to type', () => {
    for (const seed of ['1', '2', '3', '4', '5', '6', '7']) {
      const plan = proposalOpeningPlan(seed);
      expect(plan.angle_brief).toMatch(/^После приветствия/u);
      expect(plan.rule).toContain('своими словами');
    }
  });
});

describe('hollow short accents', () => {
  const lead = 'Длинное вводное предложение нужно только для того, чтобы разбор предложений вообще запустился и метрика посчиталась корректно. ';
  const emptyAccents = (tail: string) => require('./ai.service').proposalHumanityMetrics(lead + tail).emptyAccentCount;

  test.each([
    'Это проверяемо.',
    'Риск под контролем.',
    'Это ключевая развилка.',
    'Здесь это особенно полезно.',
    'Всё под контролем.',
    'Так данные не расходятся.',
    'Так ошибка сразу заметна.',
  ])('«%s» is filler, not a beat', (accent) => {
    expect(emptyAccents(accent)).toBeGreaterThan(0);
  });

  test.each([
    'Начну с него.',
    'Данные не разойдутся.',
    'Дизайн у вас готов.',
    'Это экономит время.',
    'Сначала фиксируем границу.',
    'Затык обычно в идентификаторе.',
  ])('«%s» carries meaning and survives', (accent) => {
    expect(emptyAccents(accent)).toBe(0);
  });
});

describe('estimate confidence', () => {
  const { proposalEstimateContext } = require('./ai.service');

  test('a detailed brief with a confident analysis is a grounded estimate', () => {
    const result = proposalEstimateContext(
      { description: 'x'.repeat(3_000) },
      { confidence: 90 },
    );
    expect(result.mode).toBe('grounded');
  });

  test.each([
    ['почти пустой заказ', { description: 'ТЗ в файле' }, { confidence: 49 }],
    ['короткое описание', { description: 'y'.repeat(266) }, { confidence: 69 }],
    ['длинное, но непонятное', { description: 'z'.repeat(2_000) }, { confidence: 40 }],
  ])('%s даёт только грубую прикидку', (_name, lead, analysis) => {
    expect(proposalEstimateContext(lead, analysis).mode).toBe('rough');
  });

  test('attachments count towards the brief being answerable', () => {
    const withoutFiles = proposalEstimateContext({ description: 'a'.repeat(200) }, { confidence: 80 });
    const withFiles = proposalEstimateContext(
      { description: 'a'.repeat(200), requirements: { project: { attachments: [{}, {}] } } },
      { confidence: 80 },
    );
    expect(withoutFiles.mode).toBe('rough');
    expect(withFiles.mode).toBe('grounded');
  });
});
