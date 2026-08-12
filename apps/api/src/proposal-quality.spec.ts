import {
  portfolioEvidenceIssues,
  portfolioHumanityIssues,
  normalizeProposalFormatting,
  proposalFinalBlockingIssues,
  proposalHumanityMetrics,
  proposalHumanityWarnings,
  proposalOpeningPlan,
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

  test('a bare paraphrase is rejected for missing the proof and the gotcha', () => {
    const issues = proposalResearchIssues(
      'Здравствуйте. Telegram и MAX подключу к одной регистрации, чтобы данные не расходились. Доступ к API уже есть?',
      'standard',
    );
    expect(issues.join(' ')).toContain('70–130 слов');
    expect(issues.join(' ')).toContain('делал похожий проект');
    expect(issues.join(' ')).toContain('ссылку на свой кейс');
    expect(issues.join(' ')).toContain('затык');
    // The owner cut these out of the shape, so their absence must no longer be an issue.
    expect(issues.join(' ')).not.toContain('микро-план');
    expect(issues.join(' ')).not.toContain('критерий приёмки');
  });

  test('accepts the short shape the owner dictated', () => {
    const content = `Добрый день!

Готов взяться, опыт в таких задачах есть. Делал похожее. EXPO MATCH, сервис нетворкинга на выставке, где анкета, профиль и QR-бейдж партнёра жили одной записью и сверялись на входе, вот он https://example.test/expo

Нюанс тут обычно в идентификаторе. Пока не решено, что считается одним партнёром, каналы разъезжаются по документам и согласиям. Вылезает это уже на живых людях. У вас я разведу это до сборки, чтобы потом не сводить записи руками.

По деньгам ориентировочно выходит 110 000 рублей и 16 дней, это исходя из того, как я понял задачу по описанию. У вас уже есть одобренный API у MAX? Если появятся вопросы, готов ответить здесь в чате или в телеграме @saveliissdd`;
    expect(proposalResearchIssues(content, 'standard', {
      price: 110_000, days: 16, contactTelegram: '@saveliissdd', estimateMode: 'grounded',
    })).toEqual([]);
  });

  test('a thin brief must admit the number is a ballpark', () => {
    const content = `Добрый день!

Возьмусь, такие правки делал много раз. Собирал похожее. Сайт бренда с управляемыми блоками, где новые разделы редактор добавлял сам, без разработчика, вот он https://example.test/brand

Косяк тут обычно на адаптиве. Блоки, вынесенные в общий шаблон, начинают жить своей жизнью на планшетных ширинах, если состояния не описаны. Я проверю их у вас отдельно.

По деньгам навскидку это порядка 60 000 рублей и около 7 дней, но вводных пока мало, так что цифра очень примерная. Посмотрю вашу задачу подробнее и посчитаю точнее. Скинете список правок или доступ к сайту? Если что, пишите в чат или в телеграм @saveliissdd`;
    expect(proposalResearchIssues(content, 'standard', {
      price: 60_000, days: 7, contactTelegram: '@saveliissdd', estimateMode: 'rough',
    })).toEqual([]);
  });

  test('a grounded wording is not enough when the brief is actually thin', () => {
    const grounded = `Добрый день!

Готов взяться, опыт в таких задачах есть. Делал похожее. EXPO MATCH, сервис нетворкинга на выставке, где анкета, профиль и QR-бейдж партнёра жили одной записью и сверялись на входе, вот он https://example.test/expo

Нюанс тут обычно в идентификаторе. Пока не решено, что считается одним партнёром, каналы разъезжаются по документам и согласиям. Вылезает это уже на живых людях. У вас я разведу это до сборки, чтобы потом не сводить записи руками.

По деньгам ориентировочно выходит 110 000 рублей и 16 дней, это исходя из того, как я понял задачу по описанию. У вас уже есть одобренный API у MAX? Если появятся вопросы, готов ответить здесь в чате или в телеграме @saveliissdd`;
    const issues = proposalResearchIssues(grounded, 'standard', {
      price: 110_000, days: 16, contactTelegram: '@saveliissdd', estimateMode: 'rough',
    });
    expect(issues.join(' ')).toContain('Вводных в заказе мало');
    expect(issues.join(' ')).toContain('уточнить цифры');
  });

  test('a price with no hedge at all reads as a firm quote and is rejected', () => {
    const firm = `Добрый день!

Готов взяться, опыт в таких задачах есть. Делал похожее. EXPO MATCH, сервис нетворкинга на выставке, где анкета, профиль и QR-бейдж партнёра жили одной записью и сверялись на входе, вот он https://example.test/expo

Нюанс тут обычно в идентификаторе. Пока не решено, что считается одним партнёром, каналы разъезжаются по документам и согласиям. Вылезает это уже на живых людях. У вас я разведу это до сборки, чтобы потом не сводить записи руками.

По деньгам ориентировочно выходит 110 000 рублей и 16 дней, это исходя из того, как я понял задачу по описанию. У вас уже есть одобренный API у MAX? Если появятся вопросы, готов ответить здесь в чате или в телеграме @saveliissdd`.replace('ориентировочно выходит', 'выходит ровно');
    const issues = proposalResearchIssues(firm, 'standard', {
      price: 110_000, days: 16, contactTelegram: '@saveliissdd', estimateMode: 'grounded',
    });
    expect(issues.join(' ')).toContain('звучат как готовая смета');
  });

  test('typeset punctuation and a missing contact are both reported', () => {
    const withDashes = `Добрый день!

Готов взяться, опыт в таких задачах есть. Делал похожее. EXPO MATCH, сервис нетворкинга на выставке, где анкета, профиль и QR-бейдж партнёра жили одной записью и сверялись на входе, вот он https://example.test/expo

Нюанс тут обычно в идентификаторе. Пока не решено, что считается одним партнёром, каналы разъезжаются по документам и согласиям. Вылезает это уже на живых людях. У вас я разведу это до сборки, чтобы потом не сводить записи руками.

По деньгам выходит 110 000 рублей и 16 дней. У вас уже есть одобренный API у MAX? Если появятся вопросы, готов ответить здесь в чате или в телеграме @saveliissdd`.replace('EXPO MATCH, сервис', 'EXPO MATCH — сервис');
    const issues = proposalResearchIssues(withDashes, 'standard', {
      price: 110_000, days: 16, contactTelegram: '@nosuchuser',
    });
    expect(issues.join(' ')).toContain('тире');
    expect(issues.join(' ')).toContain('@nosuchuser');
    // The link keeps its own colon and slashes without being flagged.
    expect(issues.join(' ')).not.toContain('слеш');
  });

  test('the reference proposal carries its proof up front, with the link beside it', () => {
    const content = `Добрый день!

Telegram и MAX у вас должны вести партнёра в одну запись — в этом вся задача. Делал похожее: EXPO MATCH, сервис нетворкинга на выставке, где анкета, profile и QR-бейдж жили одной записью — https://example.test/expo

Затык обычно в идентификаторе. Пока не решено, что считается одним партнёром, каналы разъезжаются по документам и согласиям, а вылезает это уже на живых людях. Я разведу это до сборки, чтобы потом не переклеивать записи руками.

По деньгам: 110 000 ₽ и 16 дней. У вас уже есть одобренный API у MAX?`;
    const proofParagraph = content.split(/\n\s*\n/u).findIndex((paragraph) => paragraph.includes('http'));
    // The proof must not be something the client has to scroll for.
    expect(proofParagraph).toBeLessThanOrEqual(1);
    expect(content).toMatch(/Делал похожее/u);
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

  test('rotates an opening approach instead of dictating a first phrase', () => {
    const named = proposalOpeningPlan('lead-42', 'Владимир');
    expect(named.greeting).toBe('Здравствуйте, Владимир!');
    expect(proposalOpeningPlan('lead-42').greeting).toBeNull();
    // The plan must never hand the model a ready-made first sentence.
    expect(named.angle_brief).toMatch(/^После приветствия/u);
    expect(named.banned_openings).toContain('у вас в задаче');
  });

  test('an opening already used in recent drafts is reported so it is not repeated', () => {
    const plan = proposalOpeningPlan('lead-7', '', [
      'Здравствуйте! У вас в задаче смешаны витрина и магазин, я бы развёл их по этапам.',
      'Я делал маркетплейс фермерских продуктов, там была та же связка каталога и остатков.',
    ]);
    expect(plan.already_used_openings).toEqual(expect.arrayContaining(['у вас в задаче смешаны']));
    expect(plan.already_used_openings.length).toBeGreaterThanOrEqual(2);
  });

  test('the earlier long reference is now out of shape: the owner asked for a short letter', () => {
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
    // This text was the reference in the previous naturalness round. The owner has since
    // dictated a much shorter shape, so it is expected to fail on length and on the
    // missing gotcha — this test records that reversal deliberately.
    expect(issues.join(' ')).toContain('70–130 слов');
    expect(issues.join(' ')).toContain('затык');
    expect(proposalFinalBlockingIssues(content, issues).length).toBeGreaterThan(0);
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

  test('allows the owner-requested first-person opening', () => {
    const issues = proposalResearchIssues(
      'Я разработчик и готов выполнить вашу задачу. Сначала я сверю макеты. Потом соберу страницы. В конце ваш сотрудник проверит сайт. Всё будет понятно. Приёмка: страницы открываются. Цена 110 000 ₽, срок 16 дней. Мобильные макеты у вас готовы?',
      'standard',
      { price: 110_000, days: 16, acceptanceLabel: 'acceptance' },
    ).join(' ');
    expect(issues).not.toContain('не об исполнителе');
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

  test('requires price, duration and availability without forcing a client name', () => {
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
    expect(issues).not.toContain('Владимир');
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
