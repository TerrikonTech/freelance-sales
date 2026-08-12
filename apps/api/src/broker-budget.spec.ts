import { estimateBrokerContext, fitAiPayload, proposalReviewReductions } from './ai.service';
import { ProcessorService } from './processor.service';

const filler = (chars: number, seed: string) => seed.repeat(Math.ceil(chars / seed.length)).slice(0, chars);

/** A payload shaped like the real draft_review one that the broker rejected in production. */
const oversizedReviewPayload = () => ({
  mode: 'response',
  context: { lead: { title: 'Магазин', description: filler(9_000, 'описание заказа ') }, messages: Array.from({ length: 40 }, (_, index) => ({ direction: 'inbound', content: filler(300, `сообщение ${index} `) })) },
  portfolio: Array.from({ length: 6 }, (_, index) => ({ title: `Кейс ${index}`, description: filler(900, 'подробности кейса '), url: `https://example.com/${index}`, case_card: { client_context: filler(500, 'контекст ') } })),
  response_principles: Array.from({ length: 40 }, (_, index) => filler(150, `принцип ${index} `)),
  calibration_examples: Array.from({ length: 8 }, (_, index) => filler(400, `пример ${index} `)),
  recent_drafts: Array.from({ length: 6 }, (_, index) => filler(560, `черновик ${index} `)),
  approved_examples: Array.from({ length: 3 }, (_, index) => filler(560, `одобрено ${index} `)),
  voice_examples: Array.from({ length: 5 }, (_, index) => filler(300, `голос ${index} `)),
  style: Array.from({ length: 20 }, (_, index) => filler(150, `стиль ${index} `)),
  candidates: Array.from({ length: 3 }, (_, index) => ({ angle: `угол ${index}`, content: filler(1_200, `кандидат ${index} `) })),
  candidate_diagnostics: Array.from({ length: 3 }, (_, index) => ({ index, issues: Array.from({ length: 8 }, (__, issue) => filler(120, `замечание ${issue} `)) })),
  strategy: { plan: filler(2_000, 'план ') },
});

describe('broker input budget', () => {
  test('a payload that already fits is passed through untouched', () => {
    const small = { mode: 'response', context: { lead: { title: 'Небольшой заказ' } } };
    const result = fitAiPayload(small, proposalReviewReductions());
    expect(result.applied).toEqual([]);
    expect(result.fits).toBe(true);
    expect(result.payload).toBe(small);
  });

  test('an oversized review payload is brought under the broker limit', () => {
    const payload = oversizedReviewPayload();
    expect(estimateBrokerContext(payload)).toBeGreaterThan(31_000);
    const result = fitAiPayload(payload, proposalReviewReductions());
    expect(result.fits).toBe(true);
    expect(result.size).toBeLessThanOrEqual(30_000);
    expect(result.applied.length).toBeGreaterThan(0);
  });

  test('shrinking never drops what the reviewer is judging', () => {
    const result = fitAiPayload(oversizedReviewPayload(), proposalReviewReductions());
    expect(result.payload.candidates).toHaveLength(3);
    expect(result.payload.strategy).toBeDefined();
    expect(Array.isArray(result.payload.portfolio)).toBe(true);
    expect((result.payload.portfolio as unknown[]).length).toBeGreaterThan(0);
    expect((result.payload.context as any).lead.title).toBe('Магазин');
  });

  test('style corpora are sacrificed before the lead and the candidates', () => {
    const result = fitAiPayload(oversizedReviewPayload(), proposalReviewReductions());
    expect(result.applied[0]).toBe('calibration_examples');
    expect(result.applied).not.toContain('candidate_diagnostics');
  });

  test('the estimate mirrors the broker: one long string is collapsed, not counted whole', () => {
    const single = { text: filler(200_000, 'a') };
    // The broker stops at the first string limit that fits, so this lands near 8 000 —
    // vastly below the raw size and comfortably inside the budget.
    const size = estimateBrokerContext(single);
    expect(size).toBeLessThanOrEqual(30_000);
    expect(size).toBeLessThan(10_000);
  });
});

describe('permanent job failures', () => {
  test.each([
    'Task context exceeds the Hermes input limit',
    'Отклик не прошёл финальную проверку качества: текст звучит как шаблон',
    'Канал sms не поддерживается',
    'Текст изменён после одобрения',
  ])('%s is never replayed', (message) => {
    expect(ProcessorService.isPermanentFailure(message)).toBe(true);
  });

  test.each([
    'Время ожидания Codex истекло',
    'Hermes did not return a JSON object',
    'fetch failed',
  ])('%s stays retryable', (message) => {
    expect(ProcessorService.isPermanentFailure(message)).toBe(false);
  });
});
