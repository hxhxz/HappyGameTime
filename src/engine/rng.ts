// Counter-based deterministic RNG. A logical stream is isolated from every
// other stream, and the complete state is serializable for exact replay.
export interface RngState {
  algorithm: 'counter32-v1';
  seed: number;
  stream: string;
  counter: number;
}

export interface Rng {
  next(): number; // [0,1)
  int(maxExclusive: number): number; // [0, maxExclusive)
  state(): RngState;
  fork(stream: string): Rng;
}

function hashStream(stream: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < stream.length; i++) hash = Math.imul(hash ^ stream.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

function counterWord(seed: number, stream: string, counter: number): number {
  let value = (seed ^ hashStream(stream) ^ Math.imul(counter + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

export function makeRng(seed: number, stream = 'default', initialCounter = 0): Rng {
  let counter = initialCounter;
  const next = (): number => {
    const value = counterWord(seed >>> 0, stream, counter++);
    return value / 4294967296;
  };
  return {
    next,
    int: (maxExclusive: number) => {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error('rng.int requires a positive integer bound');
      return Math.floor(next() * maxExclusive);
    },
    state: () => ({ algorithm: 'counter32-v1', seed: seed >>> 0, stream, counter }),
    fork: child => makeRng(seed, `${stream}/${child}`, 0),
  };
}

export function restoreRng(state: RngState): Rng {
  if (state.algorithm !== 'counter32-v1') throw new Error(`unsupported RNG algorithm: ${state.algorithm}`);
  return makeRng(state.seed, state.stream, state.counter);
}

/** 原地 Fisher–Yates 洗牌（用给定 rng，确定性）。返回同一数组以便链式。 */
export function shuffleInPlace<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}
