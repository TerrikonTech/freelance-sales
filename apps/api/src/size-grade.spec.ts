import { isUnderpriced, sizeGrade, underpricingRatio, UNDERPRICED_RATIO } from './pricing-policy';

describe('sizeGrade', () => {
  it('bins by fair price thresholds', () => {
    expect(sizeGrade(0)).toBe('small');
    expect(sizeGrade(15_000)).toBe('small');
    expect(sizeGrade(99_999)).toBe('small');
    expect(sizeGrade(100_000)).toBe('medium');
    expect(sizeGrade(299_999)).toBe('medium');
    expect(sizeGrade(300_000)).toBe('large');
    expect(sizeGrade(1_000_000)).toBe('large');
  });

  it('treats non-numeric input as small', () => {
    expect(sizeGrade(Number.NaN)).toBe('small');
    expect(sizeGrade(-5)).toBe('small');
  });
});

describe('underpricingRatio', () => {
  it('returns fair-to-named ratio', () => {
    expect(underpricingRatio(1_000_000, 100_000)).toBe(10);
    expect(underpricingRatio(250_000, 100_000)).toBe(2.5);
  });

  it('returns null on missing or invalid inputs', () => {
    expect(underpricingRatio(0, 100_000)).toBeNull();
    expect(underpricingRatio(100_000, 0)).toBeNull();
    expect(underpricingRatio(Number.NaN, 100_000)).toBeNull();
    expect(underpricingRatio(100_000, Number.NaN)).toBeNull();
  });
});

describe('isUnderpriced', () => {
  it('flags named budget at or below the trap ratio', () => {
    expect(isUnderpriced(1_000_000, 100_000)).toBe(true);
    expect(isUnderpriced(250_000, 100_000)).toBe(true);
  });

  it('passes budgets close to the fair price', () => {
    expect(isUnderpriced(100_000, 90_000)).toBe(false);
    expect(isUnderpriced(100_000, 100_000)).toBe(false);
  });

  it('never flags when the budget is missing', () => {
    expect(isUnderpriced(1_000_000, 0)).toBe(false);
  });

  it('keeps the trap ratio aligned with severeBudgetMismatch math', () => {
    // severeBudgetMismatch: price > budget * 2.5 === ratio > 2.5; the flag uses >=
    expect(UNDERPRICED_RATIO).toBe(2.5);
  });
});
