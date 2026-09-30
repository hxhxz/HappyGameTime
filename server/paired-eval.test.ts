import { describe, expect, it } from 'vitest';
import { defaultPolicyRegistry, pairedEvaluate, requiredPairCount } from './paired-eval';

describe('paired seat-rotated evaluation', () => {
  it('reports exactly zero for identical policies under common seeds', async () => {
    const result = await pairedEvaluate('heuristic-honest', 'heuristic-honest', 'heuristic-honest', defaultPolicyRegistry(), [101]);
    expect(result.failures).toEqual([]);
    expect(result.pairs).toBe(1);
    expect(result.seatRotationsPerPair).toBe(4);
    expect(result.meanDelta).toBe(0);
    expect(result.ciLow).toBe(0);
    expect(result.ciHigh).toBe(0);
  }, 20_000);

  it('estimates pair count from pilot variance before a formal run', () => {
    expect(requiredPairCount(0.2, 0.1)).toBe(32);
  });
});
