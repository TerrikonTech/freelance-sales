import { ownerDeliveryResultMessage } from './telegram.service';

/**
 * The owner saw "Бот не может писать в этот чат" and read it as a refusal,
 * then never got the promised follow-up even though the message had been delivered.
 */
describe('handed-off delivery wording', () => {
  test('the hand-off reads as progress, not as a refusal', () => {
    const message = ownerDeliveryResultMessage({
      status: 'failed',
      leadTitle: 'Олег Зотов',
      channel: 'telegram',
      error: 'Bad Request: BUSINESS_PEER_INVALID',
    });
    expect(message).toContain('Отправляю');
    expect(message).toContain('с вашего аккаунта');
    expect(message).not.toContain('не может');
    expect(message).not.toContain('Не отправлено');
  });

  test('the follow-up names the account that actually sent it', () => {
    expect(ownerDeliveryResultMessage({
      status: 'sent',
      leadTitle: 'Олег Зотов',
      channel: 'telegram',
      error: 'Bad Request: BUSINESS_PEER_INVALID [userbot] queued:x [userbot] delivered',
    })).toContain('с вашего аккаунта');
  });

  test('an ordinary bot send is still reported plainly', () => {
    const message = ownerDeliveryResultMessage({
      status: 'sent', leadTitle: 'Олег', channel: 'fl',
    });
    expect(message).toContain('Отправлено');
    expect(message).toContain('FL.ru');
    expect(message).not.toContain('с вашего аккаунта');
  });

  test('a real failure is still called a failure', () => {
    expect(ownerDeliveryResultMessage({
      status: 'failed', leadTitle: 'Олег', channel: 'telegram', error: 'CHAT_WRITE_FORBIDDEN',
    })).toContain('Не отправлено');
  });
});
