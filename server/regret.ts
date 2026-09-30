import { applyAction, legalMoves, passTurn, type Action, type GameState } from '../src/engine';
import { makeRng, shuffleInPlace } from '../src/engine/rng';
import type { ArtifactIdentity, RegretLabel } from '../src/decision/types';
import { rankCandidates, type AgentStyle } from './strategy';

const TURN_CAP = 2_000;

function actionKey(action: Action): string {
  return JSON.stringify(action);
}

/**
 * Honest deck-order belief sample for the current ruleset. The public deck sizes
 * and every visible/private allocation stay fixed; only unobserved order changes.
 * Opponent-hand identity sampling requires reservation provenance in schema v2 and
 * is deliberately not guessed from legacy snapshots.
 */
export function sampleHonestWorld(state: GameState, seed: number): GameState {
  const sampled = structuredClone(state);
  const rng = makeRng(seed);
  for (const deck of Object.values(sampled.decks)) {
    const blindSlots = sampled.players.flatMap((player, playerIndex) => player.reserved.map((card, reserveIndex) => ({ player, playerIndex, reserveIndex, card }))).filter(slot => {
      const { player, card } = slot;
      const origin = sampled.reservationOrigins[card.id];
      return player.id !== sampled.players[sampled.currentPlayerIndex].id && origin?.kind === 'deck' && origin.pile === deck.key;
    });
    const blindReservations = blindSlots.map(slot => slot.card);
    const pool = [...deck.drawPile, ...blindReservations];
    shuffleInPlace(pool, rng);
    for (const slot of blindSlots) delete sampled.reservationOrigins[slot.card.id];
    blindSlots.forEach((slot, index) => {
      const replacement = pool[index];
      slot.player.reserved[slot.reserveIndex] = replacement;
      sampled.reservationOrigins[replacement.id] = { kind: 'deck', pile: deck.key as 1 | 2 | 3 };
    });
    deck.drawPile = pool.slice(blindSlots.length);
  }
  return sampled;
}

function terminalRankUtility(state: GameState, playerId: string): number {
  const ordered = [...state.players].sort((a, b) => b.points - a.points || b.evolved.length - a.evolved.length || a.purchased.length - b.purchased.length);
  const rank = ordered.findIndex(player => player.id === playerId);
  if (rank < 0) throw new Error('focal player missing');
  return state.players.length === 1 ? 1 : 1 - rank / (state.players.length - 1);
}

function continuation(state: GameState, focalId: string, style: AgentStyle): number {
  let current = state;
  let steps = 0;
  while (!current.isGameOver && steps++ < TURN_CAP) {
    const moves = legalMoves(current);
    if (!moves.length) { current = passTurn(current); continue; }
    const ranked = rankCandidates(current, moves, style, moves.length);
    if (!ranked.length) throw new Error('honest continuation produced no candidate');
    current = applyAction(current, ranked[0].action);
  }
  if (!current.isGameOver) throw new Error('regret rollout exceeded turn cap');
  return terminalRankUtility(current, focalId);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function ci95(values: number[]): [number, number] {
  const avg = mean(values);
  if (values.length < 2) return [avg, avg];
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  const half = 1.96 * Math.sqrt(variance / values.length);
  return [avg - half, avg + half];
}

export interface RegretHarnessOptions {
  artifact: ArtifactIdentity;
  decisionId: string;
  baselineAction: Action;
  rolloutPairs: number;
  seed: number;
  highRegretThreshold: number;
  continuationStyle?: AgentStyle;
}

export function labelDecisionRegret(state: GameState, options: RegretHarnessOptions): RegretLabel {
  const legal = legalMoves(state);
  if (!legal.some(action => actionKey(action) === actionKey(options.baselineAction))) throw new Error('baseline action is not legal');
  if (options.rolloutPairs < 2) throw new Error('regret labels require at least two rollout pairs');
  const focalId = state.players[state.currentPlayerIndex].id;
  const style = options.continuationStyle ?? '抢分型';
  const utilityByAction = new Map<string, number[]>();
  for (const action of legal) utilityByAction.set(actionKey(action), []);

  for (let pair = 0; pair < options.rolloutPairs; pair++) {
    const world = sampleHonestWorld(state, (options.seed + Math.imul(pair + 1, 0x9e3779b9)) >>> 0);
    for (const action of legal) {
      const utility = continuation(applyAction(world, action), focalId, style);
      utilityByAction.get(actionKey(action))!.push(utility);
    }
  }

  const actionMeans = legal.map(action => ({ action, value: mean(utilityByAction.get(actionKey(action))!) })).sort((a, b) => b.value - a.value);
  const bestAction = actionMeans[0].action;
  const baselineValues = utilityByAction.get(actionKey(options.baselineAction))!;
  const bestValues = utilityByAction.get(actionKey(bestAction))!;
  const pairedRegrets = bestValues.map((value, index) => value - baselineValues[index]);
  const expectedRegret = mean(pairedRegrets);
  const [ciLow, ciHigh] = ci95(pairedRegrets);
  return {
    artifact: options.artifact,
    decisionId: options.decisionId,
    baselineAction: structuredClone(options.baselineAction), bestAction: structuredClone(bestAction),
    expectedRegret, ciLow, ciHigh, rolloutPairs: options.rolloutPairs,
    labelQuality: ciLow > options.highRegretThreshold || ciHigh < options.highRegretThreshold ? 'high' : 'uncertain',
    utilityDefinition: 'terminal normalized rank utility; common-random-number paired rollouts',
    evaluatorVersion: 'regret-harness-v1-deck-order-belief',
  };
}
