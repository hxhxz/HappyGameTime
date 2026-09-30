import { applyAction, legalMoves, passTurn, type Action, type GameState } from '../src/engine';
import { makeRng, type Rng } from '../src/engine/rng';
import { publicView, viewHash } from '../src/decision/views';
import type { OpponentModelInput, OpponentStudent, SearchEvidence } from '../src/decision/types';
import { sampleHonestWorld } from './regret';

interface Stat { visits: number; q: number }
interface Node { visits: number; actions: Map<string, Stat> }

export interface PomcpOptions {
  simulations: number;
  ownTurns: number;
  exploration?: number;
  gamma?: number;
  seed: number;
  opponent: OpponentStudent;
}

export interface PomcpResult {
  action: Action;
  evidence: Map<string, SearchEvidence>;
  elapsedMs: number;
  simulations: number;
  depthPly: number;
}

const keyOf = (action: Action) => JSON.stringify(action);

function rankUtility(state: GameState, focalId: string): number {
  const ordered = [...state.players].sort((a, b) => b.points - a.points || b.evolved.length - a.evolved.length || a.purchased.length - b.purchased.length);
  const rank = ordered.findIndex(player => player.id === focalId);
  return rank < 0 ? 0 : 1 - rank / Math.max(1, state.players.length - 1);
}

function leafUtility(state: GameState, focalId: string): number {
  if (state.isGameOver) return rankUtility(state, focalId);
  const focal = state.players.find(player => player.id === focalId);
  if (!focal) return 0;
  const leader = Math.max(...state.players.map(player => player.points), 18);
  return Math.max(0, Math.min(1, focal.points / leader));
}

function chooseOpponent(state: GameState, legal: Action[], opponent: OpponentStudent, rng: Rng): Action {
  const active = state.players[state.currentPlayerIndex];
  const input: OpponentModelInput = {
    publicView: publicView(state), publicHistory: state.log.slice(-8), opponentId: active.id,
    revealedBehaviorFeatures: {}, legalActions: legal,
  };
  const distribution = opponent.predict(input).probabilities.filter(item => legal.some(action => keyOf(action) === keyOf(item.action)) && item.probability > 0);
  if (!distribution.length) return legal[rng.int(legal.length)];
  const total = distribution.reduce((sum, item) => sum + item.probability, 0);
  let draw = rng.next() * total;
  for (const item of distribution) { draw -= item.probability; if (draw <= 0) return item.action; }
  return distribution.at(-1)!.action;
}

export const uniformOpponentStudent: OpponentStudent = {
  modelVersion: 'uniform-public-v1',
  predict: input => ({
    modelVersion: 'uniform-public-v1',
    probabilities: input.legalActions.map(action => ({ action, probability: 1 / input.legalActions.length })),
  }),
};

export function pomcpHonest(root: GameState, options: PomcpOptions): PomcpResult {
  if (options.simulations < 1) throw new Error('POMCP requires at least one simulation');
  const focalId = root.players[root.currentPlayerIndex].id;
  const depthPly = Math.max(1, options.ownTurns * root.players.length);
  const exploration = options.exploration ?? Math.SQRT2;
  const gamma = options.gamma ?? 1;
  const tree = new Map<string, Node>();
  const started = Date.now();

  function simulate(state: GameState, history: string, depth: number, rng: Rng): number {
    if (state.isGameOver || depth >= depthPly) return leafUtility(state, focalId);
    const legal = legalMoves(state);
    if (!legal.length) return gamma * simulate(passTurn(state), `${history}|pass`, depth + 1, rng);
    if (state.players[state.currentPlayerIndex].id !== focalId) {
      const action = chooseOpponent(state, legal, options.opponent, rng);
      const next = applyAction(state, action);
      return gamma * simulate(next, `${history}|o:${keyOf(action)}:${viewHash(publicView(next))}`, depth + 1, rng);
    }

    let node = tree.get(history);
    if (!node) {
      node = { visits: 0, actions: new Map(legal.map(action => [keyOf(action), { visits: 0, q: 0 }])) };
      tree.set(history, node);
    }
    for (const action of legal) if (!node.actions.has(keyOf(action))) node.actions.set(keyOf(action), { visits: 0, q: 0 });
    const unvisited = legal.find(action => node!.actions.get(keyOf(action))!.visits === 0);
    const action = unvisited ?? legal.reduce((best, candidate) => {
      const bestStat = node!.actions.get(keyOf(best))!;
      const stat = node!.actions.get(keyOf(candidate))!;
      const bestUct = bestStat.q + exploration * Math.sqrt(Math.log(Math.max(1, node!.visits)) / bestStat.visits);
      const uct = stat.q + exploration * Math.sqrt(Math.log(Math.max(1, node!.visits)) / stat.visits);
      return uct > bestUct ? candidate : best;
    });
    const next = applyAction(state, action);
    const value = gamma * simulate(next, `${history}|a:${keyOf(action)}:${viewHash(publicView(next))}`, depth + 1, rng);
    const stat = node.actions.get(keyOf(action))!;
    node.visits++;
    stat.visits++;
    stat.q += (value - stat.q) / stat.visits;
    return value;
  }

  for (let i = 0; i < options.simulations; i++) {
    const seed = (options.seed + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
    simulate(sampleHonestWorld(root, seed), 'root', 0, makeRng(seed ^ 0xa511e9b3));
  }
  const rootNode = tree.get('root');
  if (!rootNode) throw new Error('POMCP did not expand root');
  const legal = legalMoves(root);
  const action = legal.reduce((best, candidate) => {
    const a = rootNode.actions.get(keyOf(best))!;
    const b = rootNode.actions.get(keyOf(candidate))!;
    return b.visits > a.visits || (b.visits === a.visits && b.q > a.q) ? candidate : best;
  });
  const evidence = new Map<string, SearchEvidence>();
  for (const candidate of legal) {
    const stat = rootNode.actions.get(keyOf(candidate))!;
    evidence.set(keyOf(candidate), {
      visits: stat.visits, meanQ: stat.q,
      uncertainty: stat.visits ? 1 / Math.sqrt(stat.visits) : 1,
      searchVersion: 'pomcp-honest-v1-public-history',
    });
  }
  return { action, evidence, elapsedMs: Date.now() - started, simulations: options.simulations, depthPly };
}
