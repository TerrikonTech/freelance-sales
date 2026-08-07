import {
  AutonomyPolicyConfig,
  classifySafeAutonomyClass,
  evaluateAutonomy,
  strictApprovalEnabled,
} from './autonomy.service';

describe('smart autonomy fail-closed policy', () => {
  const smart: AutonomyPolicyConfig = {
    mode: 'smart',
    globalPaused: false,
    minAutoConfidence: 0.92,
  };

  const evaluate = (inbound: string, outbound = 'Спасибо за вопрос. Работаю с такими системами регулярно.') => (
    evaluateAutonomy({ inbound, outbound, mode: 'chat' }, smart)
  );

  test('manual approval remains the default behavior', () => {
    const result = evaluateAutonomy(
      { inbound: 'Как вы работаете?', outbound: 'Сначала уточняю задачу.', mode: 'chat' },
      { ...smart, mode: 'manual' },
    );
    expect(result).toMatchObject({ decision: 'ask_owner', signals: ['manual_mode'] });
  });

  test('safe class can be measured while global sending stays manual', () => {
    expect(classifySafeAutonomyClass('Как вы обычно работаете?')).toBe('safe_process_faq');
    expect(classifySafeAutonomyClass('Обсудим цену и срок?')).toBeNull();
  });

  test('strict approval is fail-closed by default', () => {
    expect(strictApprovalEnabled(undefined)).toBe(true);
    expect(strictApprovalEnabled('true')).toBe(true);
    expect(strictApprovalEnabled('false')).toBe(false);
  });

  test.each([
    ['price', 'Можно скидку по цене?'],
    ['deadline', 'Когда будет готово и какой срок?'],
    ['scope', 'Это входит в объём работ?'],
    ['warranty', 'Какую гарантию вы даёте?'],
    ['contract', 'Работаем по договору и акту?'],
    ['payment', 'Как внести предоплату?'],
    ['telegram move', 'Давайте перейдём в Telegram'],
    ['files', 'Куда загрузить файлы и архив?'],
    ['secrets', 'Пришлю логин, пароль и API key'],
    ['negative', 'Я недоволен, всё не работает'],
  ])('asks owner for %s', (_, inbound) => {
    const result = evaluate(inbound);
    expect(result.decision).toBe('ask_owner');
    expect(result.confidence).toBeGreaterThanOrEqual(0.99);
  });

  test('asks owner when the generated reply introduces a commitment', () => {
    const result = evaluate('Как вы работаете?', 'Сделаю за 5 дней, цена 100 000 ₽.');
    expect(result.decision).toBe('ask_owner');
    expect(result.signals).toEqual(expect.arrayContaining(['price_or_discount', 'deadline_or_schedule']));
  });

  test.each([
    ['captcha', ['FL.ru запросил CAPTCHA']],
    ['layout', ['Интерфейс FL.ru изменился']],
    ['authentication', ['Сессия FL.ru недействительна']],
  ])('asks owner for connector %s failure', (_, runtimeSignals) => {
    const result = evaluateAutonomy(
      { inbound: 'Какой статус?', outbound: 'Работа идёт по плану.', mode: 'chat', runtimeSignals },
      smart,
    );
    expect(result).toMatchObject({ decision: 'ask_owner', confidence: 1 });
    expect(result.signals).toContain('connector_risk');
  });

  test('skips duplicate input exactly once', () => {
    const result = evaluateAutonomy(
      { inbound: 'Какой статус?', outbound: 'Проверяю.', mode: 'chat', duplicate: true },
      smart,
    );
    expect(result).toMatchObject({ decision: 'skip', confidence: 1, signals: ['duplicate'] });
  });

  test.each([
    ['ack', 'Спасибо!'],
    ['ack emoji', '👍'],
    ['spam', 'Казино и быстрый заработок прямо сейчас'],
  ])('skips %s', (_, inbound) => {
    expect(evaluate(inbound).decision).toBe('skip');
  });

  test.each([
    ['experience FAQ', 'Есть ли у вас опыт с такими проектами?'],
    ['process FAQ', 'Как вы обычно работаете?'],
    ['technical FAQ', 'Какой стек используете?'],
    ['status', 'Как продвигается работа?'],
    ['clarification', 'Какой информации не хватает?'],
  ])('auto-sends only safe %s', (_, inbound) => {
    const result = evaluate(inbound);
    expect(result).toMatchObject({ decision: 'auto_send', confidence: 0.95 });
  });

  test('asks owner when classification is uncertain', () => {
    expect(evaluate('Ну что думаете по этому поводу?')).toMatchObject({
      decision: 'ask_owner',
      signals: ['low_classification_confidence'],
    });
  });

  test('asks owner for low lead confidence even on a safe FAQ', () => {
    const result = evaluateAutonomy(
      {
        inbound: 'Как вы работаете?',
        outbound: 'Сначала уточняю вводные.',
        mode: 'chat',
        leadConfidence: 60,
      },
      smart,
    );
    expect(result).toMatchObject({ decision: 'ask_owner', signals: ['low_lead_confidence'] });
  });

  test('never auto-sends an initial FL response', () => {
    const result = evaluateAutonomy(
      { inbound: 'Нужен сайт', outbound: 'Готов помочь.', mode: 'response' },
      smart,
    );
    expect(result.decision).toBe('ask_owner');
    expect(result.signals).toContain('initial_response');
  });

  test('never lets an active mission bypass FL manual review', () => {
    const result = evaluateAutonomy(
      {
        inbound: 'Как вы обычно работаете?',
        outbound: 'Сначала уточняю вводные.',
        mode: 'chat',
        channel: 'fl',
        mission: { instruction: 'общайся сам', turnsLeft: 3, expired: false, exhausted: false },
      },
      smart,
    );
    expect(result).toMatchObject({ decision: 'ask_owner', signals: ['platform_manual_review'] });
  });

  test('respects a stricter confidence threshold', () => {
    const result = evaluateAutonomy(
      { inbound: 'Какой у вас процесс работы?', outbound: 'Сначала уточняю вводные.', mode: 'chat' },
      { ...smart, minAutoConfidence: 0.98 },
    );
    expect(result.decision).toBe('ask_owner');
  });
});
