import {
  looksLikeOwnerDeliveryCommand,
  parseOwnerOutboundRequest,
  parseOwnerSendApproval,
} from './telegram.service';

/**
 * Regression pack for the phrasing the owner actually used in Telegram.
 * Every case below returned null before this fix and fell through to the
 * analytical path, which answered "не могу отправить … в режиме изолированного анализа".
 */
describe('owner send commands as actually spoken', () => {
  test('the exact phrase from the screenshot composes and sends', () => {
    expect(parseOwnerOutboundRequest(
      'Напиши сообщение и отправь Олегу Зотову на эльфийском здорово Чокак.',
    )).toEqual({
      instructions: 'на эльфийском здорово Чокак.',
      recipient: 'Олегу Зотову',
      sendNow: true,
    });
  });

  test('a pronoun means the lead already in focus', () => {
    expect(parseOwnerOutboundRequest('напиши ему сообщение на эльфийском')).toEqual({
      instructions: 'на эльфийском',
      recipient: null,
      sendNow: false,
    });
  });

  test('a voice lead-in before an approval no longer breaks it', () => {
    expect(parseOwnerSendApproval('ну так отправь ему')).toEqual({ recipient: null });
  });

  test.each([
    ['Напиши сообщение и отправь Олегу привет', 'Олегу', 'привет', true],
    ['напиши сообщение Олегу что он молодец', 'Олегу', 'что он молодец', false],
    ['смотри отправь Олегу Зотову что всё готово', 'Олегу Зотову', 'что всё готово', true],
  ])('parses %s', (value, recipient, instructions, sendNow) => {
    expect(parseOwnerOutboundRequest(value as string))
      .toEqual({ instructions, recipient, sendNow });
  });

  test('a full name approval keeps both words', () => {
    expect(parseOwnerSendApproval('отправь Олегу Зотову')).toEqual({ recipient: 'Олегу Зотову' });
  });

  test('compose-and-send is not mistaken for an approval', () => {
    expect(parseOwnerSendApproval('отправь Олегу привет')).toBeNull();
    expect(parseOwnerOutboundRequest('отправь Олегу привет')?.sendNow).toBe(true);
  });

  test.each([
    'напиши сообщение и потом отправь Олегу привет',
    'отправь Олегу Зотову когда он ответит',
  ])('still refuses a deferred send: %s', (value) => {
    expect(parseOwnerOutboundRequest(value)).toBeNull();
    expect(looksLikeOwnerDeliveryCommand(value)).toBe(true);
  });

  test.each(['напиши что нового', 'скажи сколько лидов', 'напиши сообщение'])(
    'still treats an owner question as a question: %s',
    (value) => {
      expect(parseOwnerOutboundRequest(value)).toBeNull();
    },
  );
});
