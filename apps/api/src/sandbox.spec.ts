import { buildSandboxSteps, isSandboxLead, SANDBOX_SCENARIOS } from './sandbox';

describe('sandbox isolation', () => {
  test('requires both the dedicated source and an explicit marker', () => {
    expect(isSandboxLead({ source: 'sandbox', client: { sandbox: true } })).toBe(true);
    expect(isSandboxLead({ source: 'sandbox', client: {} })).toBe(false);
    expect(isSandboxLead({ source: 'fl', client: { sandbox: true } })).toBe(false);
    expect(isSandboxLead(null)).toBe(false);
  });

  test('ships realistic scenarios without an FL.ru URL', () => {
    expect(Object.keys(SANDBOX_SCENARIOS)).toEqual(expect.arrayContaining(['web_service', 'ecommerce', 'vague']));
    for (const scenario of Object.values(SANDBOX_SCENARIOS)) {
      expect(scenario.title.length).toBeGreaterThan(10);
      expect(scenario.description.length).toBeGreaterThan(80);
      expect(scenario).not.toHaveProperty('url');
    }
  });

  test('the detailed protocol requires a real Telegram turn, not just a linked token', () => {
    const common = {
      analysisState: 'completed', score: 85, confidence: 91,
      initialDrafts: [{ status: 'sent', content: 'Отклик' }],
      flDrafts: [{ status: 'sent', content: 'Ответ FL' }],
      telegramDrafts: [] as Array<{ status: string; content: string }>,
      messages: [
        { channel: 'fl', direction: 'inbound' },
        { channel: 'fl', direction: 'outbound' },
      ],
      handoffs: [{ status: 'used', from_channel: 'fl', to_channel: 'telegram' }],
      requirements: [{ status: 'confirmed' }],
      documents: [{ kind: 'specification' }, { kind: 'contract_data' }, { kind: 'contract' }, { kind: 'codex_handoff' }],
      designCount: 2,
      deliveries: [{ status: 'sent', external_id: 'sandbox:one', error: '[sandbox] external write blocked' }],
    };
    const steps = buildSandboxSteps(common);
    expect(steps.find((step) => step.key === 'handoff')?.done).toBe(true);
    expect(steps.find((step) => step.key === 'telegram_client_reply')?.done).toBe(false);
    expect(steps.find((step) => step.key === 'telegram_agent_reply')?.done).toBe(false);
  });

  test('keeps Telegram on-demand in production while the sandbox explicitly queues its own reply', () => {
    const source = require('node:fs').readFileSync(require.resolve('./sandbox.service'), 'utf8');
    expect(source).toContain("channel: 'telegram'");
    expect(source).toContain('ownerRequested: true');
    expect(source).toContain('sandbox-telegram-chat-');
  });

  test('marks the full transcript complete only when every delivery stays in the sandbox', () => {
    const steps = buildSandboxSteps({
      analysisState: 'completed', score: 85, confidence: 91,
      initialDrafts: [{ status: 'sent', content: 'Отклик' }],
      flDrafts: [{ status: 'sent', content: 'Ответ FL' }],
      telegramDrafts: [{ status: 'sent', content: 'Ответ Telegram' }],
      messages: [
        { channel: 'fl', direction: 'inbound' },
        { channel: 'telegram', direction: 'inbound' },
      ],
      handoffs: [{ status: 'used', from_channel: 'fl', to_channel: 'telegram' }],
      requirements: [{ status: 'confirmed' }, { status: 'open' }],
      documents: [{ kind: 'specification' }, { kind: 'contract_data' }, { kind: 'contract' }, { kind: 'codex_handoff' }],
      designCount: 2,
      deliveries: [
        { status: 'sent', external_id: 'sandbox:one', error: '[sandbox] external write blocked' },
        { status: 'sent', external_id: 'sandbox:two', error: '[sandbox] external write blocked' },
      ],
    });
    expect(steps).toHaveLength(13);
    expect(steps.every((step) => step.done)).toBe(true);
    expect(steps.find((step) => step.key === 'isolation')?.evidence).toContain('подозрительных внешних доставок 0');
  });

  test('fails the isolation proof if a delivery lacks the sandbox marker', () => {
    const isolation = buildSandboxSteps({
      analysisState: 'idle', score: null, confidence: null,
      initialDrafts: [], flDrafts: [], telegramDrafts: [], messages: [], handoffs: [], requirements: [], documents: [], designCount: 0,
      deliveries: [{ status: 'sent', external_id: 'real-message-id', error: null }],
    }).find((step) => step.key === 'isolation');
    expect(isolation).toEqual(expect.objectContaining({ done: false, failed: true }));
  });
});
