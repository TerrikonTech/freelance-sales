import {
  portfolioEvidenceIssues,
  portfolioHumanityIssues,
  normalizeProposalFormatting,
  proposalFinalBlockingIssues,
  proposalHumanityMetrics,
  proposalHumanityWarnings,
  proposalOpeningSeed,
  proposalProfileForLead,
  proposalResearchIssues,
  proposalTechnologyFitContext,
  proposalTechnologyIssues,
  proposalVariationPlan,
  selectRelevantPortfolio,
  selectVoiceprintExamples,
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
    const content = `У вас Telegram и MAX должны вести партнёра в одну запись: согласие с офертой, документы и partner_id не должны расходиться. Данные не разойдутся.

Сначала я проверю, как MAX идентифицирует пользователя и принимает файлы. Когда методы будут ясны, соберу общий путь регистрации и выдачи QR-кода. Затем ваш менеджер получит тестовое уведомление и сам проведёт партнёра по обоим мессенджерам. Приёмка: данные остаются в одной карточке.

Я делал анкету участника, профиль и QR-бейдж в EXPO MATCH — у вас совпадает сама связка регистрации с идентификатором: https://example.test/expo По деньгам это 110 000 ₽ и 16 дней. Старт — после согласования объёма и получения доступов. У MAX уже есть одобренный API или его ещё нужно получать?`;
    expect(proposalResearchIssues(content, 'standard', {
      price: 110_000,
      days: 16,
      availability: 'после согласования объёма и получения доступов',
      availabilityConfigured: true,
      acceptanceLabel: 'acceptance',
    })).toEqual([]);
  });

  test('measures human rhythm and rejects a sterile proposal voice', () => {
    const sterile = 'Важно определить границы проекта до разработки. Необходимо согласовать редакцию и лицензию. Следует провести тестирование адаптива и прав доступа. Результат можно принимать после демонстрации. Стоимость составляет 250 000 ₽. Срок составляет 45 дней. Нужен кабинет?';
    const metrics = proposalHumanityMetrics(sterile);
    expect(metrics.clientAddressCount).toBe(0);
    expect(metrics.impersonalStartCount).toBeGreaterThanOrEqual(3);
    const issues = proposalResearchIssues(sterile, 'standard', { price: 250_000, days: 45 }).join(' ');
    expect(issues).toContain('написан «в воздух»');
    expect(issues).toContain('безлично');
  });

  test('uses 0.60 as a target but only blocks burstiness below 0.55', () => {
    const soft = proposalHumanityMetrics(
      'У вас готов макет. Я сверю все страницы. Потом соберу основные блоки. Ваш менеджер проверит формы. На тестовом домене я покажу каталог, кабинет, новости, формы и настройки. Риск понятен.',
    );
    expect(soft.burstiness).toBeGreaterThanOrEqual(0.55);
    expect(soft.burstiness).toBeLessThan(0.6);
    expect(soft.burstinessHardFail).toBe(false);
    expect(proposalHumanityWarnings(soft)).toHaveLength(1);

    const hard = proposalHumanityMetrics(
      'У вас готов макет сайта. Я сверю все страницы. Потом соберу все блоки. Ваш менеджер проверит формы. Я покажу готовый результат. Какой раздел делать первым?',
    );
    expect(hard.burstinessHardFail).toBe(true);
  });

  test('formats an ungrouped commercial price without spending an AI retry', () => {
    expect(normalizeProposalFormatting('По деньгам: 250000 ₽ и 45 дней.', { price: 250_000 }))
      .toBe('По деньгам: 250 000 ₽ и 45 дней.');
  });

  test('detects adjacent structural parallelism and long sentences without a short beat', () => {
    const metrics = proposalHumanityMetrics(
      'Я сначала подробно сверю все экраны будущего кабинета с вашим большим макетом, проверю состояния форм, таблиц, карточек, меню и уведомлений до начала основной разработки продукта. Я потом подробно соберу все экраны будущего кабинета с вашим большим макетом, проверю состояния форм, таблиц, карточек, меню и уведомлений до показа результата вашей команде. Границы будут видны.',
    );
    expect(metrics.parallelismPairCount).toBeGreaterThan(0);
    expect(metrics.longSentenceFollowupMissCount).toBeGreaterThan(0);
  });

  test('rotates a deterministic opening seed and keeps a confirmed greeting', () => {
    expect(proposalOpeningSeed('lead-42', 'Владимир')).toMatch(/^Здравствуйте, Владимир!\n\n/u);
    expect(proposalOpeningSeed('lead-42')).not.toContain('Владимир');
  });

  test('accepts the owner naturalness-regulation reference after reducing it to one question', () => {
    const content = `Здравствуйте!

У вас в задаче смешаны две разные вещи: сайт-витрина клиники и будущий магазин с корзиной и оплатой. Я бы их сразу развёл. Витрину делаем сейчас, а под магазин просто закладываем структуру каталога, чтобы потом не переписывать. Иначе смета расползётся ещё до старта.

Дизайн у вас готов — это сильно упрощает работу. По шагам вижу так: сначала выбираем редакцию Битрикса и договариваемся, что входит в личный кабинет — регистрация и профиль. Потом собираю каталог и страницы на тестовом домене. В конце гоняем админку: чтобы ваш сотрудник сам, без меня, добавил товар и новость. Если сможет — этап принят.

Похожую механику я делал для медицинской платформы «МЕДСЕТЬ 24»: личный кабинет с тремя ролями — пациент, врач, администратор, у каждого свой набор прав. Самое хитрое было развести доступ так, чтобы врач видел только своих пациентов. Ссылка на проект: https://www.fl.ru/user/sporyshevsaveli/portfolio/8057734/. Скажу честно: тот проект был не на Битриксе, стек другой. Но логика кабинета и прав от CMS почти не зависит.

По деньгам: 250 000 ₽ и 45 дней, промежуточное показываю на тестовом домене примерно раз в неделю.

Кабинет на первом этапе — только регистрация и профиль, или сразу нужна запись к врачу?`;
    const metrics = proposalHumanityMetrics(content);
    expect(metrics.burstiness).toBe(0.49);
    const issues = proposalResearchIssues(content, 'standard', {
      price: 250_000,
      days: 45,
      availabilityConfigured: false,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('Ритм провален');
    expect(proposalFinalBlockingIssues(content, issues)).toEqual([]);
  });

  test('rejects synthetic short fillers instead of counting them as human rhythm', () => {
    const synthetic = `У вас готов дизайн медицинской витрины. Всё прозрачно. Сначала я сверю макеты и каталог. Потом соберу кабинет и формы.

Ваш сотрудник проверит каталог и профиль. Приёмка: он добавляет товар без меня. Цена 250 000 ₽ и срок 45 дней.

Я делал медицинский кабинет с картой пациента. У вас похожая предметная область. Ссылка: https://example.test/med Кабинет включает только профиль?`;
    const metrics = proposalHumanityMetrics(synthetic);
    expect(metrics.emptyAccentCount).toBe(1);
    expect(proposalResearchIssues(synthetic, 'standard', {
      price: 250_000,
      days: 45,
      acceptanceLabel: 'acceptance',
    }).join(' ')).toContain('пустым филлером');
  });

  test('requires an honest stack mismatch disclosure when a neighbouring case is linked', () => {
    const fit = proposalTechnologyFitContext(
      { title: 'Сайт на 1С-Битрикс', description: 'Каталог и личный кабинет' },
      {},
      [{ title: 'МЕДСЕТЬ 24', description: 'Next.js кабинет пациента', url: 'https://example.test/med' }],
    );
    expect(proposalTechnologyIssues(
      'Я делал кабинет пациента: https://example.test/med На первом шаге сверю редакцию 1С-Битрикс.',
      fit,
    ).join(' ')).toContain('кейс не подтверждает 1С-Битрикс');
    expect(proposalTechnologyIssues(
      'Я делал кабинет пациента: https://example.test/med Скажу честно: тот проект был не на 1С-Битрикс, стек другой.',
      fit,
    )).toEqual([]);
  });

  test('uses Unicode-safe boundaries for Russian first-person openings', () => {
    const issues = proposalResearchIssues(
      'Я разработчик и готов выполнить вашу задачу. Сначала я сверю макеты. Потом соберу страницы. В конце ваш сотрудник проверит сайт. Всё будет понятно. Приёмка: страницы открываются. Цена 110 000 ₽, срок 16 дней. Мобильные макеты у вас готовы?',
      'standard',
      { price: 110_000, days: 16, acceptanceLabel: 'acceptance' },
    ).join(' ');
    expect(issues).toContain('не об исполнителе');
  });

  test('does not treat ordinary domain terms and adverbs as bureaucratic nominalizations', () => {
    const metrics = proposalHumanityMetrics(
      'Дизайн медицинской организации полностью на вашей стороне. Стоимость фиксирую заранее. Ваш пользователь проходит регистрацию. Для определения границы я сначала сверю сценарий.',
    );
    expect(metrics.nominalizationCount).toBe(1);
  });

  test('requires a first-person case detail grounded in the stored portfolio card', () => {
    const portfolio = [{
      title: 'МЕДСЕТЬ 24',
      description: 'Пациентский кабинет показывает ближайшие записи, результаты анализов и назначения.',
      url: 'https://example.test/med',
    }];
    expect(portfolioHumanityIssues(
      'В кейсе МЕДСЕТЬ 24 проектировал роли и личный кабинет: https://example.test/med',
      portfolio,
    ).join(' ')).toContain('от первого лица');
    expect(portfolioHumanityIssues(
      'Я делал МЕДСЕТЬ 24: в кабинете пациент видел ближайшие записи и результаты анализов. https://example.test/med',
      portfolio,
    )).toEqual([]);
  });

  test('selects only three topic-near voiceprint examples', () => {
    const selected = selectVoiceprintExamples([
      'Я собирал каталог и корзину магазина.',
      'Сверстал небольшой лендинг.',
      'В магазине я проверял варианты товара и остатки.',
      'Настроил уведомления Telegram.',
    ], 'мобильный магазин: каталог, варианты товара, остатки', 3);
    expect(selected).toHaveLength(3);
    expect(selected.slice(0, 2).join(' ')).toContain('корзину магазина');
    expect(selected.slice(0, 2).join(' ')).toContain('варианты товара');
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

  test('rejects an overloaded opening sentence even when the underlying observation is useful', () => {
    const issues = proposalResearchIssues(
      'Готовый дизайн действительно ускорит сборку сайта, но личный кабинет без подробно описанного пользовательского сценария и будущий интернет-магазин без отдельной схемы незаметно расширят объём первого этапа ещё до начала разработки. План: 1) согласую границу; 2) соберу сайт. Приёмка: каталог открывается. Цена 250000 ₽, срок 45 дней. ЛК нужен?',
      'standard',
      { price: 250_000, days: 45, availabilityConfigured: false, acceptanceLabel: 'acceptance' },
    ).join(' ');
    expect(issues).toContain('не более 24 слов');
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
