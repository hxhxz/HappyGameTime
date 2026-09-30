import { applyAction, createGame, legalMoves, passTurn, type GameState } from '../src/engine';
import { makeRng } from '../src/engine/rng';
import { CARDS } from '../src/data/cards';
import { artifactIdentity } from '../src/decision/identity';
import type { ArtifactIdentity } from '../src/decision/types';
import { buildCandidatePipeline } from './policy-runtime';
import { CandidateTopPolicy, PolicyRegistry, type DecisionPolicy, type PolicyContext } from './policy-registry';
import { PomcpDecisionPolicy } from './pomcp-policy';
import { pomcpHonest, uniformOpponentStudent } from './pomcp';
import type { OpponentStudent } from '../src/decision/types';
import { readFileSync } from 'node:fs';
import { frequencyOpponentStudent } from './opponent-student';

export interface PairedEvaluationResult {
  artifact: ArtifactIdentity;
  anchorPolicyId: string;
  candidatePolicyId: string;
  opponentPolicyId: string;
  pairs: number;
  seatRotationsPerPair: number;
  meanDelta: number;
  ciLow: number;
  ciHigh: number;
  sampleStdDev: number;
  failures: string[];
}

export function defaultPolicyRegistry(extra: DecisionPolicy[] = []): PolicyRegistry {
  const registry = new PolicyRegistry();
  registry.register(new CandidateTopPolicy('heuristic-honest', 'v2-neutral'));
  registry.register(new PomcpDecisionPolicy('pomcp-honest-uniform', 'v1-best-response-reference', 64, 2));
  for (const policy of extra) registry.register(policy);
  return registry;
}

function terminalUtility(state: GameState, playerId: string): number {
  const ordered = [...state.players].sort((a, b) => b.points - a.points || b.evolved.length - a.evolved.length || a.purchased.length - b.purchased.length);
  const rank = ordered.findIndex(player => player.id === playerId);
  return 1 - rank / Math.max(1, state.players.length - 1);
}

async function play(seed: number, focalSeat: number, focalId: string, opponentId: string, registry: PolicyRegistry, searchOpponent: OpponentStudent): Promise<number> {
  let state = createGame({ players: [0, 1, 2, 3].map(i => ({ id: `P${i}`, name: `P${i}`, isAI: true })), cards: CARDS, seed });
  let guard = 0;
  while (!state.isGameOver) {
    if (guard++ > 2_000) throw new Error('paired evaluation exceeded turn cap');
    const legal = legalMoves(state);
    if (!legal.length) { state = passTurn(state); continue; }
    const policy = registry.resolve(state.currentPlayerIndex === focalSeat ? focalId : opponentId);
    const pipeline = buildCandidatePipeline(state, legal, 'neutral', legal.length, policy.candidateWeights);
    const context: PolicyContext = {
      view: pipeline.view, legalActions: legal, candidates: pipeline.evidence, rankedCandidates: pipeline.ranked,
      seat: { seat: state.currentPlayerIndex, name: state.players[state.currentPlayerIndex].name, personaMode: 'neutral' },
      rng: makeRng(seed, `paired/${focalSeat}/${state.turnNumber}/${policy.id}`),
      search: request => pomcpHonest(state, { ...request, seed: seed ^ state.turnNumber, opponent: searchOpponent }),
    };
    const decision = await policy.decide(context);
    if (!legal.some(candidate => JSON.stringify(candidate) === JSON.stringify(decision.action))) throw new Error(`${policy.id} returned an illegal action`);
    state = applyAction(state, decision.action);
  }
  return terminalUtility(state, `P${focalSeat}`);
}

function summarize(values: number[]): { mean: number; sd: number; low: number; high: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const variance = values.length < 2 ? 0 : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const sd = Math.sqrt(variance);
  const half = values.length ? 1.96 * sd / Math.sqrt(values.length) : 0;
  return { mean, sd, low: mean - half, high: mean + half };
}

export async function pairedEvaluate(candidatePolicyId: string, anchorPolicyId: string, opponentPolicyId: string, registry: PolicyRegistry, seeds: number[], searchOpponent: OpponentStudent = uniformOpponentStudent): Promise<PairedEvaluationResult> {
  const deltas: number[] = [];
  const failures: string[] = [];
  for (const seed of seeds) {
    try {
      const seatDeltas: number[] = [];
      for (const seat of [0, 1, 2, 3]) seatDeltas.push(await play(seed, seat, candidatePolicyId, opponentPolicyId, registry, searchOpponent) - await play(seed, seat, anchorPolicyId, opponentPolicyId, registry, searchOpponent));
      deltas.push(seatDeltas.reduce((sum, delta) => sum + delta, 0) / seatDeltas.length);
    } catch (error) { failures.push(`seed ${seed}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const summary = summarize(deltas);
  return {
    artifact: artifactIdentity({ candidatePolicyId, anchorPolicyId, opponentPolicyId, searchOpponent: searchOpponent.modelVersion, seeds }, process.env.CODE_REVISION || 'development'),
    anchorPolicyId, candidatePolicyId, opponentPolicyId, pairs: deltas.length, seatRotationsPerPair: 4,
    meanDelta: summary.mean, ciLow: summary.low, ciHigh: summary.high, sampleStdDev: summary.sd, failures,
  };
}

export function requiredPairCount(sampleStdDev: number, minimumDetectableEffect: number): number {
  if (!(sampleStdDev > 0) || !(minimumDetectableEffect > 0)) throw new Error('positive pilot standard deviation and effect are required');
  return Math.ceil(((1.96 + 0.84) * sampleStdDev / minimumDetectableEffect) ** 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) values.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
  const pairs = Number(values.get('pairs') ?? 20);
  const seedStart = Number(values.get('seed-start') ?? 50_000);
  const candidate = values.get('candidate') ?? 'heuristic-honest';
  const anchor = values.get('anchor') ?? 'heuristic-honest';
  const opponent = values.get('opponent') ?? 'heuristic-honest';
  const studentPath = values.get('opponent-student');
  const searchOpponent = studentPath ? frequencyOpponentStudent((JSON.parse(readFileSync(studentPath, 'utf8')).model ?? JSON.parse(readFileSync(studentPath, 'utf8')))) : uniformOpponentStudent;
  const report = await pairedEvaluate(candidate, anchor, opponent, defaultPolicyRegistry(), Array.from({ length: pairs }, (_, index) => seedStart + index), searchOpponent);
  console.log(JSON.stringify(report, null, 2));
}
