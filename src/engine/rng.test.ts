import { describe, expect, it } from 'vitest';
import { makeRng, restoreRng } from './rng';

describe('counter-based RNG', () => {
  it('serializes and resumes the exact stream position', () => {
    const rng = makeRng(42, 'rollout/3');
    rng.next(); rng.next();
    const state = rng.state();
    expect(restoreRng(state).next()).toBe(rng.next());
  });

  it('isolates logical streams from each other', () => {
    const root = makeRng(42, 'experiment');
    const belief = root.fork('belief');
    const policy = root.fork('policy');
    belief.next(); belief.next();
    expect(policy.next()).toBe(makeRng(42, 'experiment/policy').next());
  });
});
