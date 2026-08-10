import {
  portfolioEvidenceIssues,
  proposalProfileForLead,
  proposalResearchIssues,
  proposalTechnologyFitContext,
  proposalTechnologyIssues,
  proposalVariationPlan,
  selectRelevantPortfolio,
} from './ai.service';
import { calculateCatalogPrice } from './pricing-policy';

describe('proposal inputs', () => {
  test('routes a partner bot brief to a mechanically similar portfolio case', () => {
    const portfolio = [
      { title: 'CORP SITE', description: 'Корпоративный сайт и новости', url: 'https://example.test/corp' },
      { title: 'TERRA MARKET', description: 'Каталог товаров, корзина и оплата', url: 'https://example.test/store' },
      { title: 'EXPO MATCH', description: 'Участник заполняет анкету, получает профиль и контакты для нетворкинга', url: 'https://example.test/expo' },
      { title: 'MUSIC FEST', description: 'После регистрации посетитель получает QR-билет', url: 'https://example.test/music' },
      { title: 'INVOICE FLOW', description: 'Документы и уведомления менеджеру в мессенджере', url: 'https://example.test/invoice' },
      { title: 'LANDING', description: 'Лендинг для локального бизнеса', url: 'https://example.test/landing' },
      { title: 'BLOG', description: 'Блог с рубриками', url: 'https://example.test/blog' },
    ];
    const selected = selectRelevantPortfolio(
      portfolio,
      'Бот Telegram и MAX: регистрация партнёра, анкета, документы, partner_id и QR-код',
    );
    expect(selected.length).toBeGreaterThanOrEqual(3);
    expect(selected.slice(0, 3).map((item) => item.title)).toContain('EXPO MATCH');
    expect(selected.every((item) => Number(item.relevance_score) > 0)).toBe(true);
  });

  test('selects research length profiles from the real commercial scope', () => {
    expect(proposalProfileForLead({ description: 'Удалить один абзац', recommended_price: 25_000 })).toBe('compact');
    expect(proposalProfileForLead({ description: 'Разработка бота с регистрацией, документами, уведомлениями и QR-кодом'.repeat(5), recommended_price: 110_000 })).toBe('standard');
    expect(proposalProfileForLead({ description: 'Мобильный интернет-магазин с каталогом, корзиной и заказами'.repeat(5), recommended_price: 1_200_000 })).toBe('premium');
  });

  test('rejects the old short paraphrase that has no plan or acceptance criterion', () => {
    const issues = proposalResearchIssues(
      'Здравствуйте. Telegram и MAX подключу к одной регистрации, чтобы данные не расходились. Доступ к API уже есть?',
      'standard',
    );
    expect(issues.join(' ')).toContain('100–200 слов');
    expect(issues.join(' ')).toContain('критерий приёмки');
    expect(issues.join(' ')).toContain('микро-план');
  });

  test('accepts a structured FL proposal built from the research checklist', () => {
    const content = `В связке Telegram и MAX основной риск — не сама регистрация, а единая история согласия с офертой, документов и partner_id: эти данные не должны расходиться между каналами. Близкая механика уже реализована в EXPO MATCH, где анкета участника связана с его профилем и QR-бейджем: https://example.test/expo

Предлагаю начать с проверяемого этапа:
1) подтвердить возможности MAX по идентификации и приёму файлов;
2) собрать общий сценарий регистрации, статуса налогообложения и выдачи QR-кода;
3) проверить уведомление менеджеру на тестовых данных.
Приёмка: один тестовый партнёр проходит весь путь в обоих мессенджерах, а согласие, документы и partner_id сохраняются в одной записи.

Ориентир — 110 000 ₽ и 16 дней. Старт — после согласования объёма и получения доступов. У MAX уже есть одобренный API для бота или доступ пока нужно получать?`;
    expect(proposalResearchIssues(content, 'standard', {
      price: 110_000,
      days: 16,
      availability: 'после согласования объёма и получения доступов',
      availabilityConfigured: true,
      acceptanceLabel: 'acceptance',
    })).toEqual([]);
  });

  test('requires price, duration, availability and a known client name in the cover letter', () => {
    const content = `По задаче есть конкретный план. 1) Сверю исходник. 2) Внесу правку. Приёмка: текст на сайте совпадает с исходником. Кейс: https://example.test/case Прислать ссылку?`;
    const issues = proposalResearchIssues(content, 'compact', {
      price: 25_000,
      days: 2,
      availability: 'с 10 августа',
      clientName: 'Владимир',
      acceptanceLabel: 'acceptance',
    }).join(' ');
    expect(issues).toContain('25 000');
    expect(issues).toContain('2 дней');
    expect(issues).toContain('старта');
    expect(issues).toContain('Владимир');
  });

  test('rotates the acceptance wording away from a repeated AI fingerprint', () => {
    const plan = proposalVariationPlan([
      'Готово = первый результат.',
      'Готово = второй результат.',
    ], 'lead-42');
    expect(plan.acceptanceLabel).not.toBe('ready_equals');
    expect(plan.acceptanceText).not.toContain('Готово =');
  });

  test('marks an explicit CMS as elevated risk when seller and portfolio do not prove it', () => {
    const fit = proposalTechnologyFitContext(
      { title: 'Сайт-витрина на 1С-Битрикс', description: 'Каталог и личный кабинет' },
      { positioning: 'Fullstack-разработчик, 6 лет опыта' },
      [{ title: 'МЕДСЕТЬ 24', description: 'Роли и личный кабинет на другом стеке', url: 'https://example.test/med' }],
    );
    expect(fit).toMatchObject({ required: ['1С-Битрикс'], unverified: ['1С-Битрикс'], risk: 'elevated' });
    expect(proposalTechnologyIssues('С 1С-Битрикс работаю и архитектуру знаю.', fit).join(' ')).toContain('Нельзя заявлять опыт');
    expect(proposalTechnologyIssues('На первом шаге согласую редакцию 1С-Битрикс и структуру каталога.', fit)).toEqual([]);
  });

  test('accepts exact technology evidence only from the seller profile or portfolio', () => {
    const url = 'https://example.test/bitrix-case';
    const fit = proposalTechnologyFitContext(
      { title: 'Разработка на Битрикс', description: 'Сайт-витрина' },
      {},
      [{ title: 'Магазин на 1С-Битрикс', description: 'Каталог и инфоблоки', url }],
    );
    expect(fit.risk).toBe('none');
    expect(fit.verifiedEvidence).toHaveLength(1);
    expect(proposalTechnologyIssues(`Близкий кейс: ${url}`, fit)).toEqual([]);
    expect(proposalTechnologyIssues('Есть общий кейс с каталогом.', fit).join(' ')).toContain('добавь одно подтверждённое доказательство');
  });

  test('blocks the old generic availability placeholder when no date is configured', () => {
    const issues = proposalResearchIssues(
      'План: 1) согласую объём. 2) соберу сайт. Приёмка: каталог открывается. Цена 250000 ₽, срок 45 дней. Старт — после согласования объёма и получения необходимых материалов и доступов. ЛК нужен?',
      'standard',
      { price: 250_000, days: 45, availabilityConfigured: false, acceptanceLabel: 'acceptance' },
    ).join(' ');
    expect(issues).toContain('системную заглушку старта');
  });

  test('requires one exact case link when relevant portfolio evidence exists', () => {
    const portfolio = [{ title: 'EXPO MATCH', url: 'https://example.test/expo', relevance_score: 9 }];
    expect(portfolioEvidenceIssues('Кейс EXPO MATCH близок по механике.', portfolio)).toHaveLength(1);
    expect(portfolioEvidenceIssues('Кейс EXPO MATCH: https://example.test/expo', portfolio)).toEqual([]);
  });

  test('keeps bot pricing in a freelance-sized range', () => {
    expect(calculateCatalogPrice({
      category: 'automation_or_bot', level: 'standard', modifiers: [], estimatedDays: 16,
    })).toMatchObject({ price: 110_000, days: 16 });
    expect(calculateCatalogPrice({
      category: 'automation_or_bot', level: 'high', modifiers: [], estimatedDays: 28,
    })).toMatchObject({ price: 180_000, days: 28 });
  });

  test('prices a literal one-line content deletion as a microtask', () => {
    expect(calculateCatalogPrice({
      category: 'small_fix', level: 'low', modifiers: [], estimatedDays: 1,
    })).toMatchObject({ price: 500, days: 1 });
  });

  test('keeps a mobile-store MVP in the stated freelance range', () => {
    expect(calculateCatalogPrice({
      category: 'mobile_mvp', level: 'high', modifiers: [], estimatedDays: 60,
    })).toMatchObject({ price: 350_000, days: 60 });
  });
});
