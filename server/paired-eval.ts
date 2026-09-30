import { applyAction, createGame, legalMoves, passTurn, type Action, type GameState } from '../src/engine';
import { CARDS } from '../src/data/cards';
import { rankCandidates, type AgentStyle } from './strategy';

export interface EvaluationPolicy {
  id: string;
  choose(state: GameState, legal: Action[]): Action;
}

export interface PairedEvaluationResult {
  anchorPolicyId: string;
  candidatePolicyId: string;
  pairs: number;
  seatRotationsPerPair: number;
  meanDelta: number;
  ciLow: number;
  ciHigh: number;
  sampleStdDev: number;
  failures: string[];
}

export function honestHeuristicPolicy(id: string, style: AgentStyle): EvaluationPolicy {
  return { id, choose: (state, legal) => rankCandidates(state, legal, style, legal.length)[0].action };
}

function terminalUtility(state: GameState, playerId: string): number {
  const ordered = [...state.players].sort((a, b) => b.points - a.points || b.evolved.length - a.evolved.length || a.purchased.length - b.purchased.length);
  const rank = ordered.findIndex(player => player.id === playerId);
  return 1 - rank / Math.max(1, state.players.length - 1);
}

function play(seed: number, focalSeat: number, focal: EvaluationPolicy, opponent: EvaluationPolicy): number {
  let state = createGame({ players: [0, 1, 2, 3].map(i => ({ id: `P${i}`, name: `P${i}`, isAI: true })), cards: CARDS, seed });
  let guard = 0;
  while (!state.isGameOver) {
    if (guard++ > 2_000) throw new Error('paired evaluation exceeded turn cap');
    const legal = legalMoves(state);
    if (!legal.length) { state = passTurn(state); continue; }
    const policy = state.currentPlayerIndex === focalSeat ? focal : opponent;
    const action = policy.choose(state, legal);
    if (!legal.some(candidate => JSON.stringify(candidate) === JSON.stringify(action))) throw new Error(`${policy.id} returned an illegal action`);
    state = applyAction(state, action);
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

/** One pair is one seed averaged over all four focal-seat rotations. */
export function pairedEvaluate(candidate: EvaluationPolicy, anchor: EvaluationPolicy, opponent: EvaluationPolicy, seeds: number[]): PairedEvaluationResult {
  const deltas: number[] = [];
  const failures: string[] = [];
  for (const seed of seeds) {
    try {
      const seatDeltas = [0, 1, 2, 3].map(seat => play(seed, seat, candidate, opponent) - play(seed, seat, anchor, opponent));
      deltas.push(seatDeltas.reduce((sum, delta) => sum + delta, 0) / seatDeltas.length);
    } catch (error) { failures.push(`seed ${seed}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const summary = summarize(deltas);
  return {
    anchorPolicyId: anchor.id, candidatePolicyId: candidate.id, pairs: deltas.length, seatRotationsPerPair: 4,
    meanDelta: summary.mean, ciLow: summary.low, ciHigh: summary.high, sampleStdDev: summary.sd, failures,
  };
}

export function requiredPairCount(sampleStdDev: number, minimumDetectableEffect: number): number {
  if (!(sampleStdDev > 0) || !(minimumDetectableEffect > 0)) throw new Error('positive pilot standard deviation and effect are required');
  return Math.ceil(((1.96 + 0.84) * sampleStdDev / minimumDetectableEffect) ** 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const n = Number(process.argv[2] ?? 20);
  const seeds = Array.from({ length: n }, (_, index) => 50_000 + index);
  const anchor = honestHeuristicPolicy('honest-anchor-v1', '抢分型');
  const candidate = honestHeuristicPolicy('honest-evolution-v1', '进化型');
  console.log(JSON.stringify(pairedEvaluate(candidate, anchor, anchor, seeds), null, 2));
}

