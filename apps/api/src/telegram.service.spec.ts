import {
  shouldQueueAutomaticTelegramDraft,
  telegramOnDemandOnly,
} from './telegram.service';

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
