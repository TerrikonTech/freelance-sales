import { resolveDraftMode } from './processor.service';
import { queueAttemptsFor, queuePriorityFor } from './queue.service';

describe('latency-sensitive queue policy', () => {
  test('puts discovery ahead of background and avoids pointless scan retries', () => {
    expect(queuePriorityFor('scan-fl')).toBeLessThan(queuePriorityFor('analyze-lead'));
    expect(queuePriorityFor('analyze-lead')).toBeLessThan(queuePriorityFor('health-watchdog'));
    expect(queueAttemptsFor('scan-fl')).toBe(1);
  });
});

describe('draft mode routing', () => {
  test('treats Telegram inbound messages as chat even without an FL dialog id', () => {
    expect(resolveDraftMode('telegram', '', false)).toBe('chat');
  });

  test('keeps an initial FL proposal in response mode', () => {
    expect(resolveDraftMode('fl', '', false)).toBe('response');
  });

  test('treats an established FL dialog as chat', () => {
    expect(resolveDraftMode('fl', '', true)).toBe('chat');
  });

  test('honours an explicit mode from an owner action', () => {
    expect(resolveDraftMode('telegram', 'response', false)).toBe('response');
    expect(resolveDraftMode('fl', 'chat', false)).toBe('chat');
  });
});
