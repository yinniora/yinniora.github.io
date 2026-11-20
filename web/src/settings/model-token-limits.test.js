import { describe, expect, it } from 'vitest';
import { formatTokenLimit, parseTokenLimit } from './model-token-limits.js';

describe('model token limit units', () => {
  it.each([
    [1000000, '1M'],
    [1048576, '1.048576M'],
    [128000, '128K'],
    [8201, '8.201K'],
    [12, '12'],
  ])('round-trips %d without rounding', (amount, formatted) => {
    expect(formatTokenLimit(amount)).toBe(formatted);
    expect(parseTokenLimit(formatted.toLowerCase(), 10000000)).toBe(amount);
  });

  it('distinguishes an empty override from invalid input', () => {
    expect(parseTokenLimit('', 10000000)).toBeUndefined();
    for (const input of ['0', '-1', '1e3', '1.0001K', '1.3M', '100K bits']) {
      expect(parseTokenLimit(input, 1000000)).toBeNull();
    }
  });
});
