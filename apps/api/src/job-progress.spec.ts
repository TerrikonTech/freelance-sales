import { advanceSteps, finishSteps, planFor, JobStep } from './job-progress.service';

const keys = (steps: JobStep[]) => steps.map((step) => `${step.key}:${step.status}`);

describe('job progress steps', () => {
  test('a plan starts fully pending and keeps the documented order', () => {
    const plan = planFor('draft-reply');
    expect(plan.title).toBe('Готовлю текст ответа');
    expect(plan.steps.map((step) => step.key)).toEqual(['prepare', 'turn', 'compose', 'save']);
    expect(plan.steps.every((step) => step.status === 'pending')).toBe(true);
  });

  test('advancing closes the previous step and leaves the untouched ones pending', () => {
    const steps = advanceSteps(advanceSteps(planFor('draft-reply').steps, 'prepare', 'Готовлю'), 'compose', 'Пишу отклик');
    expect(keys(steps)).toEqual([
      'prepare:done', 'turn:skipped', 'compose:active', 'save:pending',
    ]);
  });

  test('a repeated step counts attempts instead of duplicating the row', () => {
    let steps = advanceSteps(planFor('draft-reply').steps, 'review', 'Проверяю');
    steps = advanceSteps(steps, 'review', 'Проверяю');
    steps = advanceSteps(steps, 'review', 'Проверяю');
    const review = steps.filter((step) => step.key === 'review');
    expect(review).toHaveLength(1);
    expect(review[0].attempts).toBe(3);
    expect(review[0].note).toBe('попытка 3');
  });

  test('the step a run opens on is not reported as a retry when the code advances into it', () => {
    const opened = advanceSteps(planFor('scan-fl').steps, 'fetch', 'Открываю ленту')
      .map((step) => (step.status === 'active' ? { ...step, attempts: 0 } : step));
    const entered = advanceSteps(opened, 'fetch', 'Открываю ленту');
    const fetch = entered.find((step) => step.key === 'fetch');
    expect(fetch?.attempts).toBe(1);
    expect(fetch?.note).toBeUndefined();
    const retried = advanceSteps(entered, 'fetch', 'Открываю ленту');
    expect(retried.find((step) => step.key === 'fetch')?.note).toBe('попытка 2');
  });

  test('an unknown stage is appended rather than dropped', () => {
    const steps = advanceSteps(planFor('draft-reply').steps, 'ai:experimental', 'ИИ выполняет задачу');
    expect(steps[steps.length - 1]).toEqual(expect.objectContaining({ key: 'ai:experimental', status: 'active' }));
  });

  test('a plan without a "prepare" step opens on its own first step, in order', () => {
    const plan = planFor('scan-fl');
    expect(plan.steps[0].key).toBe('fetch');
    const opened = advanceSteps(plan.steps, plan.steps[0].key, plan.steps[0].label);
    expect(opened.map((step) => step.key)).toEqual(['fetch', 'dedupe', 'read', 'save']);
    expect(opened[0].status).toBe('active');
  });

  test('a finished run never leaves a step spinning', () => {
    const steps = finishSteps(advanceSteps(planFor('draft-reply').steps, 'candidates', 'Пишу'), true);
    expect(steps.some((step) => step.status === 'active' || step.status === 'pending')).toBe(false);
    expect(steps.find((step) => step.key === 'candidates')?.status).toBe('done');
  });

  test('a failed run marks exactly the step that was running', () => {
    const steps = finishSteps(advanceSteps(planFor('send-draft').steps, 'send', 'Отправляю'), false);
    expect(keys(steps)).toEqual(['prepare:skipped', 'send:failed', 'confirm:skipped']);
  });
});
