import { AiService } from './ai.service';

describe('AiService analyzer optimization', () => {
  const service = new AiService({} as never, {} as never, {} as never);

  test.each([
    ['патентная услуга', 'Нужен патентный поверенный', 'Подать заявку в Роспатент'],
    ['вакансия', 'WordPress / PHP разработчик full-time', 'Полная занятость, собеседование и зарплата'],
    ['музыкальный менеджер', 'Ищу музыкального менеджера', 'Нужно продвижение артиста'],
    ['продажи', 'Менеджер по продажам', 'Нужно искать клиентов и получать процент от заказов'],
    ['поиск заказов', 'Нужна помощь с заказами на разработку приложений', 'Находите заказы и передаёте их за процент'],
    ['управление', 'Менеджер проектов на сайт', 'Управлять сайтом через админку'],
    ['дизайн', 'Сгенерировать картинку в ИИ', 'Нужно изображение достопримечательностей'],
    ['3D-визуализация', 'Создать 3д тур', 'Панорамы помещений и точки перехода'],
    ['приглашение', 'Приглашение на др', 'Нужно сделать красивую картинку'],
    ['инженерия', 'Разработка раздела ОВ', 'Приточно-вытяжная вентиляция административного здания'],
    ['учёба', 'Курсовая работа по организации баз данных', 'Нужно выполнить и оформить работу'],
    ['трафик', 'Нужен трафик на агрегатор', 'Требуется привлечь посетителей'],
    ['СММ', 'СММ продвижение бара', 'Нужны публикации в социальных сетях'],
    ['консалтинг', 'Сформировать бизнес модель стартапа', 'Подготовить материалы для акселератора'],
    ['инженерное ПО', 'Comsol', 'Нужно построить физическую модель'],
  ])('filters %s without GPT', (_, title, description) => {
    const result = service.prefilterLead({ title, description });
    expect(result?.should_respond).toBe(false);
    expect(result?.understanding.buyer_intent).toBe('irrelevant');
  });

  test.each([
    ['AI-автоматизация', 'Система подготовки презентаций Excel / PowerPoint / AI'],
    ['платформа', 'Закрытый клуб по подписке PWA + админка + бот'],
    ['доработка', 'Исправить SSL на VPS для сайта WordPress'],
    ['сайт', 'Разработать корпоративный сайт строительной компании'],
    ['магазин с менеджерами', 'Разработка Интернет-магазина для B2B'],
  ])('keeps %s for one GPT pass', (_, title) => {
    expect(service.prefilterLead({ title, description: title })).toBeNull();
  });

  test('fingerprint ignores volatile scan counters but changes with project content', () => {
    const base = {
      source: 'fl',
      external_id: 'project-item1',
      title: 'Интеграция API',
      description: 'Связать CRM и внешний сервис',
      budget_text: 'по договоренности',
      requirements: {
        project: {
          detail_parsed_at: '2026-07-23T10:00:00Z',
          age_minutes_at_parse: 5,
          response_count: 10,
          published_text: 'сегодня',
          attachments: [{ name: 'brief.pdf', sha256: 'abc', extracted_text: 'ТЗ', extraction: 'text' }],
        },
      },
    };
    const sameContent = {
      ...base,
      requirements: {
        project: {
          ...base.requirements.project,
          detail_parsed_at: '2026-07-23T10:05:00Z',
          age_minutes_at_parse: 10,
          response_count: 25,
        },
      },
    };
    const changedContent = { ...base, description: 'Связать CRM, API и платёжный сервис' };

    expect(service.analysisFingerprint(base)).toBe(service.analysisFingerprint(sameContent));
    expect(service.analysisFingerprint(base)).not.toBe(service.analysisFingerprint(changedContent));
  });

  test('uses one GPT task and does not double-charge a platform integration', async () => {
    const tasks = {
      run: jest.fn().mockResolvedValue({
        score: 80,
        confidence: 90,
        technical_fit: 90,
        commercial_fit: 75,
        brief_quality: 80,
        delivery_risk: 35,
        recommended_price: 900_000,
        recommended_days: 130,
        fit_reason: 'Подходит',
        client_value: 'Ценность',
        risks: [],
        questions: [],
        should_respond: true,
        pricing_category: 'platform_mvp',
        pricing_level: 'high',
        pricing_modifiers: ['integration_large'],
        understanding: {
          summary: 'Платформа клуба',
          project_kind: 'new_build',
          buyer_intent: 'ready',
          existing_system: 'no',
          confirmed_scope: ['PWA', 'админка', 'бот'],
          wishlist_or_future_scope: [],
          separate_costs: [],
          critical_unknowns: [],
          assumption_for_quote: 'Один клуб и одна платёжная система',
          pricing_category_hint: 'platform_mvp',
          pricing_level_hint: 'high',
          relevance_signals: ['Веб-продукт'],
          mismatch_signals: [],
          confidence: 90,
        },
      }),
    };
    const optimized = new AiService(
      { getPublic: jest.fn().mockResolvedValue(null) } as never,
      tasks as never,
      {} as never,
    );

    const result = await optimized.analyzeLead({
      source: 'fl',
      title: 'Закрытый клуб',
      description: 'PWA, админка, подписка и Telegram-бот',
      requirements: {},
    });

    expect(tasks.run).toHaveBeenCalledTimes(1);
    expect(tasks.run).toHaveBeenCalledWith('lead_analysis_v2', expect.any(Object));
    expect(result.recommended_price).toBe(750_000);
    expect(result.recommended_days).toBe(110);
    expect(result.pricing_modifiers).toEqual([]);
  });

  test('does not double-charge the backend integration already included in a mobile MVP', async () => {
    const tasks = {
      run: jest.fn().mockResolvedValue({
        score: 82,
        confidence: 90,
        technical_fit: 90,
        commercial_fit: 80,
        brief_quality: 85,
        delivery_risk: 40,
        recommended_price: 500_000,
        recommended_days: 80,
        fit_reason: 'Подходит',
        client_value: 'Ценность',
        risks: [],
        questions: [],
        should_respond: true,
        pricing_category: 'mobile_mvp',
        pricing_level: 'high',
        pricing_modifiers: ['integration_large'],
        understanding: {
          summary: 'Мобильный магазин',
          project_kind: 'new_build',
          buyer_intent: 'ready',
          existing_system: 'unknown',
          confirmed_scope: ['iOS', 'Android', 'backend', 'админ-панель'],
          wishlist_or_future_scope: [],
          separate_costs: [],
          critical_unknowns: [],
          assumption_for_quote: 'Один магазин',
          pricing_category_hint: 'mobile_mvp',
          pricing_level_hint: 'high',
          relevance_signals: ['Мобильный продукт'],
          mismatch_signals: [],
          confidence: 90,
        },
      }),
    };
    const optimized = new AiService(
      { getPublic: jest.fn().mockResolvedValue(null) } as never,
      tasks as never,
      {} as never,
    );

    const result = await optimized.analyzeLead({
      source: 'fl',
      title: 'Мобильный интернет-магазин',
      description: 'Каталог, корзина, backend и админ-панель',
      requirements: {},
    });

    expect(result.recommended_price).toBe(350_000);
    expect(result.recommended_days).toBe(60);
    expect(result.pricing_modifiers).toEqual([]);
  });
});


describe('AiService proposal latency', () => {
  test('creates a first proposal with exactly one AI task', async () => {
    const tasks = {
      run: jest.fn().mockResolvedValue({
        content: 'Добрый день!\n\nГотов взяться, опыт с такими задачами есть.\n\nЯ делал похожий проект, https://www.fl.ru/user/test/portfolio/1/. У вас важно заранее проверить обмен данными. Я проверю его на реальных сценариях.\n\nОриентировочно выходит 100000 рублей и 20 дней, это исходя из того, как я понял задачу по описанию. Что у вас уже готово? Готов ответить на вопросы в чате.',
        human_score: 90,
        sales_score: 90,
        specificity_score: 95,
        factual_score: 100,
        issues: [],
      }),
    };
    const settings = {
      getPublic: jest.fn().mockImplementation((key: string) => {
        if (key === 'seller_profile') return Promise.resolve({});
        if (key === 'style_profile') return Promise.resolve({});
        if (key === 'fl_portfolio_cases') return Promise.resolve([{
          title: 'Похожий проект',
          description: 'Сервис с обменом данными и проверкой реальных сценариев.',
          url: 'https://www.fl.ru/user/test/portfolio/1/',
        }]);
        return Promise.resolve(null);
      }),
    };
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const optimized = new AiService(settings as never, tasks as never, db as never);

    await optimized.draftReply({
      mode: 'response',
      lead: {
        id: 'lead-1',
        source: 'fl',
        title: 'Интеграция данных',
        description: 'Нужно связать две системы и проверить обмен данными на реальных сценариях.',
        recommended_price: 100000,
        recommended_days: 20,
        analysis: { confidence: 85 },
        requirements: {},
      },
      messages: [],
    }).catch(() => undefined);

    expect(tasks.run).toHaveBeenCalledTimes(1);
    expect(tasks.run).toHaveBeenCalledWith('draft_compose', expect.any(Object));
  });
});
