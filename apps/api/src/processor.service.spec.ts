import { resolveDraftMode } from './processor.service';

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
