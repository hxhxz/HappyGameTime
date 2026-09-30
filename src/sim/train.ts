// Four-player best-response weight search. Every fitness evaluation uses common
// seeds and complete focal-seat rotation through the shared PolicyRegistry.
import { DEFAULT_WEIGHTS, type Weights } from '../ai/heuristic';
import { pairedEvaluate, defaultPolicyRegistry } from '../../server/paired-eval';
import { CandidateTopPolicy } from '../../server/policy-registry';

const N = Number(process.argv[2] ?? 12);
const TRAIN_SEEDS = Array.from({ length: N }, (_, index) => 10_000 + index);
const TEST_SEEDS = Array.from({ length: Math.max(4, Math.ceil(N / 2)) }, (_, index) => 90_000 + index);
const ANCHOR = 'heuristic-honest';

async function fitness(weights: Weights, seeds: number[]): Promise<number> {
  const candidate = new CandidateTopPolicy('candidate', 'coordinate-search-v2', weights);
  const report = await pairedEvaluate(candidate.id, ANCHOR, ANCHOR, defaultPolicyRegistry([candidate]), seeds);
  if (report.failures.length) throw new Error(report.failures.join('; '));
  return report.meanDelta;
}

const keys = Object.keys(DEFAULT_WEIGHTS) as (keyof Weights)[];
let best: Weights = { ...DEFAULT_WEIGHTS };
let bestFit = await fitness(best, TRAIN_SEEDS);
console.log(`init paired rank delta vs ${ANCHOR} (pairs=${N}, four seat rotations): ${bestFit.toFixed(4)}`);

for (let pass = 0; pass < 3; pass++) {
  for (const key of keys) {
    for (const delta of [1.6, 1 / 1.6]) {
      const candidate: Weights = { ...best, [key]: Math.max(0, best[key] * delta) };
      const score = await fitness(candidate, TRAIN_SEEDS);
      if (score > bestFit + 0.001) {
        bestFit = score;
        best = candidate;
        console.log(`  + ${key} *${delta.toFixed(2)} -> ${score.toFixed(4)}`);
      }
    }
  }
  console.log(`pass ${pass}: ${bestFit.toFixed(4)} ${JSON.stringify(best)}`);
}

const testFit = await fitness(best, TEST_SEEDS);
console.log('TRAIN_PAIRED_DELTA', bestFit.toFixed(4));
console.log('TEST_PAIRED_DELTA', testFit.toFixed(4));
console.log('FINAL_WEIGHTS', JSON.stringify(best));
console.log('SEMANTICS', 'four-player best-response against frozen honest heuristic opponents; not self-play');
