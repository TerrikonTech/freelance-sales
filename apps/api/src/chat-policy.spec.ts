import {
  buildChatPolicySnapshot,
  classifyChatStopReasons,
  countChatQuestions,
  ownerEscalationReply,
  ownerReplyDeadline,
  reviewChatReply,
} from './chat-policy';

describe('research-backed chat policy', () => {
  test('bundles every consecutive inbound message after the last owner reply', () => {
    const snapshot = buildChatPolicySnapshot({
      channel: 'fl',
      pipelineStage: 'conversation',
      messages: [
        { direction: 'inbound', content: 'Первое старое сообщение' },
        { direction: 'outbound', content: 'Ответ владельца' },
        { direction: 'inbound', content: 'Каталог уже есть.' },
        { direction: 'inbound', content: 'Остатки приходят из МойСклад.' },
        { direction: 'inbound', content: 'Оплата — ЮKassa.' },
      ],
    });
    expect(snapshot.inboundBundle).toEqual([
      'Каталог уже есть.',
      'Остатки приходят из МойСклад.',
      'Оплата — ЮKassa.',
    ]);
  });

  test.each([
    ['Сколько будет стоить и какой срок?', 'commitment'],
    ['Давайте созвонимся с Савелием', 'human_requested'],
    ['Вы меня вообще не понимаете', 'negative_tone'],
    ['Вы бот или человек?', 'ai_identity'],
    ['Сделайте бесплатный тестовый прототип', 'red_flag'],
  ])('detects deterministic stop trigger: %s', (message, reason) => {
    expect(classifyChatStopReasons(message)).toContain(reason);
  });

  test.each([
    'Срок хранения файла — 30 дней',
    'Цена вопроса — корректно связать каталоги',
    'Работаем без созвонов, только текстом',
    'Проверю доступность API',
  ])('does not escalate a known regex false positive: %s', (message) => {
    expect(classifyChatStopReasons(message)).toEqual([]);
  });

  test('counts and caps the full discovery question budget at seven', () => {
    const snapshot = buildChatPolicySnapshot({
      channel: 'telegram',
      pipelineStage: 'discovery',
      messages: [{ direction: 'inbound', content: 'Продолжим' }],
      priorAgentReplies: [
        'Что уже есть?',
        'Где болит сильнее?',
        'Стек фиксирован?',
        'К чему привязана дата?',
        'Кто принимает решение?',
        'Как выглядит успех?',
        'Каталог ведёте сами?',
      ],
    });
    expect(snapshot.discoveryQuestionsUsed).toBe(7);
    expect(snapshot.discoveryQuestionsRemaining).toBe(0);
    expect(snapshot.responseProfile.maxQuestions).toBe(0);
  });

  test('rejects an eighth discovery question', () => {
    expect(reviewChatReply({
      reply: 'Контекст собран. Перейдём к ещё одному вопросу?',
      conversationStage: 's2_discovery',
      valueBeforeQuestion: true,
      discoveryQuestionsRemaining: 0,
      requiresOwner: false,
    })).toContain('Исчерпан бюджет из 7 discovery-вопросов.');
  });

  test('rejects a receipt-style paraphrase pretending to be value', () => {
    expect(reviewChatReply({
      reply: 'Понял: каталог есть, остатки в МойСклад, оплата через ЮKassa. Что нужно сделать?',
      conversationStage: 's2_discovery',
      valueBeforeQuestion: true,
      discoveryQuestionsRemaining: 5,
      requiresOwner: false,
      inboundBundle: ['Каталог есть', 'Остатки в МойСклад', 'Оплата через ЮKassa'],
    })).toContain('Перед вопросом только пересказ входящих фактов, а не новая ценность.');
  });

  test('rejects chat walls and questionnaire-style replies', () => {
    const issues = reviewChatReply({
      reply: `${'а'.repeat(501)} Что используете? Когда запуск?`,
      conversationStage: 's2_discovery',
      valueBeforeQuestion: false,
      discoveryQuestionsRemaining: 5,
      requiresOwner: false,
    });
    expect(issues).toEqual(expect.arrayContaining([
      'Обычная реплика длиннее 500 знаков.',
      'В реплике больше одного вопроса.',
      'Вопрос задан без ценности перед ним.',
    ]));
  });

  test('allows a longer structured specification confirmation only at S6', () => {
    expect(reviewChatReply({
      reply: 'Итоги обсуждения:\n'.concat('Требование. '.repeat(60)),
      conversationStage: 's6_spec_confirmation',
      valueBeforeQuestion: true,
      discoveryQuestionsRemaining: 1,
      requiresOwner: false,
    })).toEqual([]);
  });

  test('uses a concrete Moscow deadline for owner escalation', () => {
    const deadline = ownerReplyDeadline(new Date('2026-08-07T10:00:00Z'));
    expect(deadline).toBe('сегодня до 18:00 по Москве');
    expect(ownerEscalationReply(['commitment'], deadline)).toContain(deadline);
  });

  test('answers a direct AI question honestly', () => {
    const reply = ownerEscalationReply(['ai_identity'], 'сегодня до 18:00 по Москве');
    expect(reply).toContain('ИИ-инструмент');
    expect(reply).toContain('решения');
  });

  test('rotates escalation copy and avoids a reply already used for the lead', () => {
    const first = ownerEscalationReply(['commitment'], 'завтра', 'lead-1');
    const second = ownerEscalationReply(['commitment'], 'завтра', 'lead-1', [first]);
    expect(second).not.toBe(first);
    expect(second).toContain('завтра');
  });

  test('blocks an unreviewed numeric commitment in a safe reply', () => {
    expect(reviewChatReply({
      reply: 'Сделаю за 5 дней. Подходит?',
      conversationStage: 's2_discovery',
      valueBeforeQuestion: true,
      discoveryQuestionsRemaining: 2,
      requiresOwner: false,
    })).toContain('В безопасном автоответе обнаружен срок или длительность.');
  });

  test('counts only actual question marks', () => {
    expect(countChatQuestions('Понял. Один вопрос: каталог уже есть?')).toBe(1);
  });
});
