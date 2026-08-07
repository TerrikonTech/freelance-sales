import {
  isOwnerSendCommand,
  looksLikeOwnerDeliveryCommand,
  ownerDeliveryResultMessage,
  qualifiedLeadTelegramMessage,
  flInboundTelegramMessage,
  ownerOutboundInstructions,
  parseOwnerDesignRequest,
  parseOwnerOutboundRequest,
  parseOwnerSendApproval,
  isOwnerDiscoveryCommand,
  shouldQueueAutomaticTelegramDraft,
  TelegramService,
  telegramOnDemandOnly,
} from './telegram.service';
import { matchingRecipientLeads, recipientMatchesLead } from './sales-agent.service';

describe('Telegram on-demand policy', () => {
  test('is fail-closed and enabled by default', () => {
    expect(telegramOnDemandOnly(undefined)).toBe(true);
    expect(telegramOnDemandOnly('true')).toBe(true);
    expect(telegramOnDemandOnly('1')).toBe(true);
  });

  test.each(['false', '0', 'off', 'no'])('can only be disabled explicitly with %s', (value) => {
    expect(telegramOnDemandOnly(value)).toBe(false);
  });

  test('never queues an automatic draft in on-demand mode', () => {
    expect(shouldQueueAutomaticTelegramDraft(true, 'true')).toBe(false);
    expect(shouldQueueAutomaticTelegramDraft(false, 'true')).toBe(false);
  });

  test('legacy automatic drafts require an explicit opt-out', () => {
    expect(shouldQueueAutomaticTelegramDraft(true, 'false')).toBe(true);
  });
});

describe('Telegram owner command parsing', () => {
  test.each([
    'Отправляй',
    'отправь',
    'Отправьте!',
    'отправляйте',
    'да отправляй',
    'подтверждаю отправку',
  ])('accepts an unambiguous send command: %s', (value) => {
    expect(isOwnerSendCommand(value)).toBe(true);
  });

  test.each([
    'не отправляй',
    'пока не отправляй',
    'отправляй когда скажу',
    'отправь потом',
    'что отправить?',
    'отправить?',
  ])('rejects an ambiguous or negative send phrase: %s', (value) => {
    expect(isOwnerSendCommand(value)).toBe(false);
  });

  test.each([
    'не отправляй',
    'пока не отправляй',
    'отправляй когда скажу',
    'отправь если он ответит',
    'отправь клиенту когда скажу',
    'отправь Олегу, когда я скажу',
    'отправить?',
  ])('handles a command-shaped but unsafe send phrase without the LLM: %s', (value) => {
    expect(looksLikeOwnerDeliveryCommand(value)).toBe(true);
    expect(parseOwnerOutboundRequest(value)).toBeNull();
  });

  test.each([
    ['напиши ответ клиенту привет', 'привет'],
    ['составь сообщение заказчику: уточни сроки', 'уточни сроки'],
    ['Так а напиши Олегу что он молодец в прозе', 'что он молодец в прозе'],
    ['напиши Олегу что он молодец в прозе', 'что он молодец в прозе'],
    ['Напиши Олегу что он молодец в прозе', 'что он молодец в прозе'],
  ])('parses a draft request: %s', (value, expected) => {
    expect(ownerOutboundInstructions(value)).toBe(expected);
  });

  test.each(['напиши что нового', 'скажи сколько лидов'])('does not turn an owner question into a draft: %s', (value) => {
    expect(ownerOutboundInstructions(value)).toBeNull();
    expect(looksLikeOwnerDeliveryCommand(value)).toBe(false);
  });

  test('keeps the named recipient for lead validation', () => {
    expect(parseOwnerOutboundRequest('Напиши Олегу что он молодец')).toEqual({
      instructions: 'что он молодец',
      recipient: 'Олегу',
      sendNow: false,
    });
  });

  test.each([
    ['отправь олегу сообщение какой он молодец в прозе', 'олегу', 'какой он молодец в прозе'],
    ['скинь Олегу: всё готово', 'Олегу', 'всё готово'],
    ['отправь клиенту привет', null, 'привет'],
  ])('parses an explicit compose-and-send command: %s', (value, recipient, instructions) => {
    expect(parseOwnerOutboundRequest(value)).toEqual({ instructions, recipient, sendNow: true });
  });

  test.each([
    ['отправь олегу', 'олегу'],
    ['Отправляй', null],
    ['скинь клиенту', null],
  ])('parses approval with an optional recipient: %s', (value, recipient) => {
    expect(parseOwnerSendApproval(value)).toEqual({ recipient });
  });

  test.each(['не отправляй', 'отправь потом', 'отправляй когда скажу'])('does not approve unsafe phrasing: %s', (value) => {
    expect(parseOwnerSendApproval(value)).toBeNull();
  });

  test('matches a named recipient only to the selected lead identity', () => {
    expect(recipientMatchesLead('Олегу', { title: 'Диалог с Олегом', client: {} })).toBe(false);
    expect(recipientMatchesLead('Олегу', { title: 'Проект', client: { name: 'Олег' } })).toBe(true);
    expect(recipientMatchesLead('Олегу', { title: 'Клиент СОУС', client: { username: 'sous' } })).toBe(false);
    expect(recipientMatchesLead('Username', { title: 'Клиент СОУС', client: { username: 'sous' } })).toBe(false);
    expect(recipientMatchesLead('Марии', { title: 'Диалог', client: { name: 'Мария Сидорова' } })).toBe(true);
    expect(recipientMatchesLead('Олегу', { title: 'Проект', client: {} }, ['Олег'])).toBe(true);
    expect(recipientMatchesLead('Олегу', { title: 'Проект FL', client: { fl_name: 'Олег' } })).toBe(true);
    expect(recipientMatchesLead('kleftis30', { title: 'Проект FL', client: { fl_username: 'kleftis30' } })).toBe(true);
    expect(recipientMatchesLead('разработку', { title: 'Разработка сайта под ключ', client: {} })).toBe(false);
    expect(recipientMatchesLead('лендинг', { title: 'Лендинг для кофейни', client: {} })).toBe(false);
  });

  test('auto-selects only one real identity match and ignores project titles', () => {
    const candidates = [
      { id: 'lead-1', title: 'Разработка сайта', client: {}, recipient_aliases: [] },
      { id: 'lead-2', title: 'Диалог', client: { fl_name: 'Олег' }, recipient_aliases: ['client'] },
    ];
    expect(matchingRecipientLeads('Олегу', candidates).map((lead) => lead.id)).toEqual(['lead-2']);
    expect(matchingRecipientLeads('разработку', candidates)).toEqual([]);
  });

  test('recognizes design generation and keeps its safe limits', () => {
    expect(parseOwnerDesignRequest('Сгенерируй 4 концепции дизайна по https://example.com/project')).toEqual({
      instructions: 'Сгенерируй 4 концепции дизайна по https://example.com/project',
      referenceUrl: 'https://example.com/project',
      count: 4,
    });
    expect(parseOwnerDesignRequest('что думаешь про дизайн?')).toBeNull();
  });

  test.each(['Собери ТЗ', 'Напиши ТЗ для заказчика', 'продолжи интервью', 'собери ТЗ по проекту'])('%s starts guarded discovery', (value) => {
    expect(isOwnerDiscoveryCommand(value)).toBe(true);
  });

  test('formats conclusive and unknown delivery outcomes differently', () => {
    expect(ownerDeliveryResultMessage({
      status: 'sent', leadTitle: 'Олег', channel: 'telegram',
    })).toContain('Отправлено клиенту «Олег» через Telegram');
    expect(ownerDeliveryResultMessage({
      status: 'send_unknown', leadTitle: 'Олег', channel: 'fl',
    })).toContain('Автоповтор отключён');
  });

  test('makes qualified-lead alerts explicit and safe', () => {
    const message = qualifiedLeadTelegramMessage({
      title: 'Бот для партнёров', score: 82, price: 110_000, days: 16, url: 'https://example.test/sales/?lead=1',
    });
    expect(message).toContain('Подходящий заказ на FL.ru');
    expect(message).toContain('110 000 ₽');
    expect(message).toContain('Ничего не отправлено автоматически');
  });

  test('includes the actual FL message in the owner alert', () => {
    const message = flInboundTelegramMessage({
      title: 'Проект', author: 'Владимир', content: 'Когда сможете начать?',
    });
    expect(message).toContain('Владимир: Когда сможете начать?');
    expect(message).toContain('Черновик ответа готовится');
  });
});

describe('Telegram owner command routing', () => {
  const makeService = (
    agentPatch: Record<string, jest.Mock> = {},
    intent: Record<string, unknown> = { intent: 'question', recipient: null, instruction: null, question: null, confidence: 0.9, restated: 'вопрос' },
  ) => {
    const tasks = { run: jest.fn().mockResolvedValue(intent) };
    const settings = {
      getPublic: jest.fn().mockResolvedValue({ id: 42 }),
    };
    const agent = {
      ownerLead: jest.fn().mockResolvedValue({ id: 'lead-1' }),
      takePendingIntent: jest.fn().mockResolvedValue(null),
      setPendingIntent: jest.fn().mockResolvedValue(undefined),
      answerOwner: jest.fn().mockResolvedValue({ answer: '7 лидов' }),
      prepareOwnerOutbound: jest.fn().mockResolvedValue({
        leadTitle: 'Олег', channel: 'telegram', content: 'Текст черновика',
      }),
      approveOwnerOutbound: jest.fn().mockResolvedValue({ draftId: 'draft-1' }),
      queueOwnerDesign: jest.fn().mockResolvedValue({
        leadTitle: 'Олег', count: 4, estimatedCostUsd: 0.02,
      }),
      prepareDiscoveryOutbound: jest.fn().mockResolvedValue({
        complete: false,
        leadTitle: 'Олег',
        channel: 'telegram',
        content: 'Какой результат считаем готовым?',
        discoveryReadiness: 45,
      }),
      ...agentPatch,
    };
    const service = new TelegramService(
      {} as never, settings as never, {} as never, agent as never, {} as never, tasks as never,
    );
    const sendControlMessage = jest.fn().mockResolvedValue(undefined);
    (service as unknown as { sendControlMessage: jest.Mock }).sendControlMessage = sendControlMessage;
    return { service, agent, sendControlMessage, tasks };
  };

  test('routes an ordinary owner question to analysis instead of the delivery hint', async () => {
    const { service, agent, sendControlMessage } = makeService();
    await service.processOwnerMessage({ from: { id: 42 }, chat: { id: 42 }, text: 'Скажи сколько лидов' });
    expect(agent.answerOwner).toHaveBeenCalledWith('lead-1', 'Скажи сколько лидов');
    expect(sendControlMessage).toHaveBeenCalledWith('42', '7 лидов');
  });

  test('passes a capitalized named recipient into the guarded draft preparation', async () => {
    const { service, agent } = makeService();
    await service.processOwnerMessage({ from: { id: 42 }, chat: { id: 42 }, text: 'Напиши Олегу что он молодец' });
    expect(agent.prepareOwnerOutbound).toHaveBeenCalledWith('42', 'что он молодец', 'Олегу');
  });

  test('composes and sends from one explicit natural-language command', async () => {
    const { service, agent, sendControlMessage } = makeService();
    await service.processOwnerMessage({
      from: { id: 42 },
      chat: { id: 42 },
      text: 'отправь олегу сообщение какой он молодец в прозе',
    });
    expect(agent.prepareOwnerOutbound).toHaveBeenCalledWith('42', 'какой он молодец в прозе', 'олегу');
    expect(agent.approveOwnerOutbound).toHaveBeenCalledWith('42', 'олегу');
    expect(sendControlMessage).toHaveBeenCalledWith('42', expect.stringContaining('поставлено на отправку'));
  });

  test.each([
    'отправляй когда скажу',
    'отправь если он ответит',
    'отправь клиенту когда скажу',
    'отправь Олегу, когда я скажу',
  ])('never routes a conditional phrase to preparation or delivery: %s', async (text) => {
    const { service, agent, sendControlMessage } = makeService();
    await service.processOwnerMessage({ from: { id: 42 }, chat: { id: 42 }, text });
    expect(agent.prepareOwnerOutbound).not.toHaveBeenCalled();
    expect(agent.approveOwnerOutbound).not.toHaveBeenCalled();
    expect(sendControlMessage).toHaveBeenCalledWith('42', expect.stringContaining('Ничего не отправлено'));
  });

  test('approves a shown draft when the recipient is named', async () => {
    const { service, agent } = makeService();
    await service.processOwnerMessage({ from: { id: 42 }, chat: { id: 42 }, text: 'отправь олегу' });
    expect(agent.approveOwnerOutbound).toHaveBeenCalledWith('42', 'олегу');
    expect(agent.prepareOwnerOutbound).not.toHaveBeenCalled();
  });

  test('queues design only from an explicit owner command', async () => {
    const { service, agent, sendControlMessage } = makeService();
    await service.processOwnerMessage({ from: { id: 42 }, chat: { id: 42 }, text: 'Сгенерируй 4 концепции дизайна' });
    expect(agent.queueOwnerDesign).toHaveBeenCalledWith('42', expect.objectContaining({ count: 4 }));
    expect(sendControlMessage).toHaveBeenCalledWith('42', expect.stringContaining('не отправка клиенту'));
  });

  test('prepares one discovery question without sending it', async () => {
    const { service, agent, sendControlMessage } = makeService();
    await service.processOwnerMessage({ from: { id: 42 }, chat: { id: 42 }, text: 'Напиши ТЗ для заказчика' });
    expect(agent.prepareDiscoveryOutbound).toHaveBeenCalledWith('42');
    expect(sendControlMessage).toHaveBeenCalledWith('42', expect.stringContaining('Клиенту ничего не отправлено'));
    expect(agent.prepareOwnerOutbound).not.toHaveBeenCalled();
  });
});
