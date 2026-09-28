import { applyAction, buildBuyAction, totalTokens, type Action, type Card, type GameState, type PlayerState } from '../src/engine';
import { evaluationTerms, DEFAULT_WEIGHTS, type EvaluationTerms } from '../src/ai/heuristic';
import { ALL_PILES, COLOR_ORDER, WIN_THRESHOLD } from '../src/engine/types';

export type AgentStyle = '抢分型' | '进化型' | '控场型';
export const DEFAULT_CANDIDATE_LIMIT = 8;

export interface CandidateScoreTerms {
  evaluation: EvaluationTerms;
  pointsGained: number;
  bonusGained: number;
  evolutionGained: number;
  targetProgress: number;
  targetProgressContribution: number;
  discardPenalty: number;
  idleTokenCount: number;
  idleTokenPenalty: number;
  handPressurePenalty: number;
  buyBaseTempo: number;
  buyEfficiency: number;
  buyEfficiencyContribution: number;
  evolveAction: number;
  skipEvolution: number;
  crowdedReserve: number;
  winThreshold: number;
  personality: number;
  total: number;
}

export interface RankedCandidate {
  action: Action;
  score: number;
  terms: CandidateScoreTerms;
  /** Full relevant post-action state used only for shortlist diversity. */
  diversityKey: string;
  outcome: {
    pointsAfter: number;
    pointsGained: number;
    tokenCountAfter: number;
    bonusGained: number;
    evolvedAfter: number;
    evolutionGained: number;
    reservedAfter: number;
    mustDiscard: boolean;
  };
}

function cardForAction(state: GameState, me: PlayerState, action: Action): Card | undefined {
  let id: string | undefined;
  if (action.type === 'BUY') id = action.source.cardId;
  else if (action.type === 'RESERVE' && action.source.kind === 'board') id = action.source.cardId;
  else if (action.type === 'EVOLVE') id = action.toCardId;
  if (!id) return undefined;
  const own = me.reserved.find(c => c.id === id);
  if (own) return own;
  for (const pile of ALL_PILES) {
    const found = state.decks[pile].faceUp.find(c => c?.id === id);
    if (found) return found;
  }
  return undefined;
}

function missingForCard(player: PlayerState, card: Card): number {
  let missing = card.cost.master ?? 0;
  for (const color of COLOR_ORDER) {
    missing += Math.max(0, (card.cost[color] ?? 0) - player.bonuses[color] - player.tokens[color]);
  }
  return Math.max(0, missing - player.tokens.master);
}

interface ProgressTarget { card: Card; weight: number }

/** Stable, bounded targets chosen from the pre-action state; refills cannot change them mid-score. */
function progressTargets(state: GameState, player: PlayerState): ProgressTarget[] {
  const reservedIds = new Set(player.reserved.map(c => c.id));
  const evolutionSpecies = new Set(player.purchased.map(c => c.evolvesToSpeciesId).filter((x): x is string => !!x));
  const cards = [...player.reserved, ...ALL_PILES.flatMap(p => state.decks[p].faceUp).filter((c): c is Card => !!c)];
  const unique = [...new Map(cards.map(card => [card.id, card])).values()];
  return unique.map(card => {
    const reserved = reservedIds.has(card.id);
    const evolution = evolutionSpecies.has(card.speciesId);
    const weight = 1 + card.points * 0.25 + (reserved ? 1 : 0) + (evolution ? 1.5 : 0);
    return { card, weight, priority: (reserved ? 100 : 0) + (evolution ? 50 : 0) - missingForCard(player, card) * 3 + card.points };
  }).sort((a, b) => b.priority - a.priority).slice(0, 5).map(({ card, weight }) => ({ card, weight }));
}

function targetProgress(before: PlayerState, after: PlayerState, targets: ProgressTarget[]): number {
  return targets.reduce((sum, target) => sum + target.weight * Math.max(0, missingForCard(before, target.card) - missingForCard(after, target.card)), 0);
}

function idleTokens(player: PlayerState, targets: ProgressTarget[]): number {
  let idle = 0;
  for (const color of COLOR_ORDER) {
    const useful = targets.reduce((max, { card }) => Math.max(max, Math.max(0, (card.cost[color] ?? 0) - player.bonuses[color])), 0);
    idle += Math.max(0, player.tokens[color] - useful);
  }
  const usefulMaster = targets.reduce((max, { card }) => Math.max(max, missingForCard({ ...player, tokens: { ...player.tokens, master: 0 } }, card)), 0);
  return idle + Math.max(0, player.tokens.master - usefulMaster);
}

function opponentDemand(state: GameState, card: Card, meIndex: number): number {
  let value = 0;
  state.players.forEach((player, index) => {
    if (index !== meIndex && buildBuyAction(player, card, { kind: 'board', cardId: card.id })) value += 1 + card.points;
  });
  return value;
}

function affordableValue(player: PlayerState, card: Card): number {
  return buildBuyAction(player, card, { kind: 'board', cardId: card.id }) ? 1 + card.points * 0.3 : 0;
}

function removedBoardCardId(action: Action): string | undefined {
  if (action.type === 'BUY' && action.source.kind === 'board') return action.source.cardId;
  if (action.type === 'RESERVE' && action.source.kind === 'board') return action.source.cardId;
  if (action.type === 'EVOLVE') return action.toCardId;
  return undefined;
}

/**
 * Public-information expectation: known face-up cards are exact; a refilled slot
 * is the uniform mean over that pile's publicly known remaining composition.
 * The real shuffled top card in state.drawPile is never singled out.
 */
export function expectedAffordableCardValue(state: GameState, afterPlayer: PlayerState, action: Action): number {
  const removedId = removedBoardCardId(action);
  let value = 0;
  for (const pile of ALL_PILES) {
    let removedFromPile = false;
    for (const card of state.decks[pile].faceUp) {
      if (!card) continue;
      if (card.id === removedId) { removedFromPile = true; continue; }
      value += affordableValue(afterPlayer, card);
    }
    if (removedFromPile && state.decks[pile].drawPile.length > 0) {
      const possible = state.decks[pile].drawPile;
      value += possible.reduce((sum, card) => sum + affordableValue(afterPlayer, card), 0) / possible.length;
    }
  }
  return value;
}

export function actionLabel(action: Action, state: GameState): string {
  const colors: Record<string, string> = { red: '红', blue: '蓝', black: '黑', pink: '粉', yellow: '黄', master: '大师' };
  const me = state.players[state.currentPlayerIndex];
  const name = (id: string) => cardForAction(state, me, { type: 'EVOLVE', fromCardId: id, toCardId: id })?.nameZh || id;
  switch (action.type) {
    case 'BUY': return `捕捉 ${name(action.source.cardId)}`;
    case 'RESERVE': return action.source.kind === 'deck' ? `盲抽预订 T${action.source.pile}` : `预订 ${name(action.source.cardId)}`;
    case 'TAKE_THREE': return `拿取 ${action.colors.map(c => colors[c]).join('、')}球`;
    case 'TAKE_TWO': return `拿取 2 个${colors[action.color]}球`;
    case 'EVOLVE': return `${name(action.fromCardId)} → ${name(action.toCardId)}`;
    case 'DISCARD': return `归还 ${Object.entries(action.tokens).filter(([, n]) => n).map(([c, n]) => `${colors[c]}${n}`).join('、')}球`;
    case 'END_TURN': return '结束回合';
  }
}

function actionKey(action: Action): string {
  switch (action.type) {
    case 'BUY': return `BUY:${action.source.kind}:${action.source.cardId}`;
    case 'RESERVE': return action.source.kind === 'board' ? `RESERVE:board:${action.source.cardId}` : `RESERVE:deck:${action.source.pile}`;
    case 'TAKE_THREE': return `TAKE_THREE:${[...action.colors].sort().join(',')}`;
    case 'TAKE_TWO': return `TAKE_TWO:${action.color}`;
    case 'EVOLVE': return `EVOLVE:${action.fromCardId}:${action.toCardId}`;
    case 'DISCARD': return `DISCARD:${PAYABLE_COLORS.map(c => action.tokens[c]).join(',')}`;
    case 'END_TURN': return 'END_TURN';
  }
}

const PAYABLE_COLORS = [...COLOR_ORDER, 'master'] as const;

function actionFamily(action: Action): string {
  if (action.type === 'TAKE_THREE' || action.type === 'TAKE_TWO') return 'TAKE';
  return action.type;
}

function publicOutcomeDiversityKey(beforeState: GameState, afterState: GameState, player: PlayerState, action: Action): string {
  const removedId = removedBoardCardId(action);
  return JSON.stringify({
    tokens: PAYABLE_COLORS.map(c => player.tokens[c]),
    bonuses: COLOR_ORDER.map(c => player.bonuses[c]),
    points: player.points,
    purchased: player.purchased.map(c => c.id).sort(),
    reserved: player.reserved.map(c => action.type === 'RESERVE' && action.source.kind === 'deck' && !beforeState.players[beforeState.currentPlayerIndex].reserved.some(before => before.id === c.id) ? `unknown:T${action.source.pile}` : c.id).sort(),
    evolved: player.evolved.map(c => c.id).sort(),
    market: ALL_PILES.flatMap(p => beforeState.decks[p].faceUp.map(c => c?.id === removedId ? `unknown:${p}` : c?.id ?? null)),
    awaitingDiscard: afterState.awaitingDiscard,
    awaitingEvolve: afterState.awaitingEvolve,
    gameOver: afterState.isGameOver,
  });
}

function diverseSlice(ranked: RankedCandidate[], limit: number): RankedCandidate[] {
  if (ranked.length <= limit) return ranked;
  const chosen: RankedCandidate[] = [];
  const keys = new Set<string>();
  const families = new Set<string>();
  const outcomes = new Set<string>();
  for (const candidate of ranked) {
    const family = actionFamily(candidate.action);
    if (!families.has(family)) { chosen.push(candidate); keys.add(actionKey(candidate.action)); families.add(family); outcomes.add(candidate.diversityKey); }
    if (chosen.length === limit) return chosen.sort((a, b) => b.score - a.score);
  }
  for (const candidate of ranked) {
    const key = actionKey(candidate.action);
    if (!keys.has(key) && !outcomes.has(candidate.diversityKey)) {
      chosen.push(candidate); keys.add(key); outcomes.add(candidate.diversityKey);
    }
    if (chosen.length === limit) return chosen.sort((a, b) => b.score - a.score);
  }
  for (const candidate of ranked) {
    const key = actionKey(candidate.action);
    if (!keys.has(key)) { chosen.push(candidate); keys.add(key); }
    if (chosen.length === limit) break;
  }
  return chosen.sort((a, b) => b.score - a.score);
}

export function rankCandidates(state: GameState, moves: Action[], style: AgentStyle, limit = DEFAULT_CANDIDATE_LIMIT): RankedCandidate[] {
  const idx = state.currentPlayerIndex;
  const before = state.players[idx];
  const beforeBonus = COLOR_ORDER.reduce((sum, c) => sum + before.bonuses[c], 0);
  const targets = progressTargets(state, before);
  const ranked: RankedCandidate[] = [];
  const seenActions = new Set<string>();
  for (const action of moves) {
    const key = actionKey(action);
    if (seenActions.has(key)) continue;
    seenActions.add(key);
    const card = cardForAction(state, before, action);
    let afterState: GameState;
    try { afterState = applyAction(state, action); } catch { continue; }
    const after = afterState.players[idx];
    const bonusAfter = COLOR_ORDER.reduce((sum, c) => sum + after.bonuses[c], 0);
    const pointsGained = after.points - before.points;
    const bonusGained = bonusAfter - beforeBonus;
    const evolutionGained = after.evolved.length - before.evolved.length;
    const expectedAffordable = expectedAffordableCardValue(state, after, action);
    const evaluation = evaluationTerms(afterState, idx, DEFAULT_WEIGHTS, { affordableCardValue: expectedAffordable });
    const progress = targetProgress(before, after, targets);
    const targetProgressContribution = progress;
    const discardPenalty = afterState.awaitingDiscard ? -Math.max(0, totalTokens(after.tokens) - 10) * 18 : 0;
    const idleTokenCount = idleTokens(after, targets);
    const idleTokenPenalty = -idleTokenCount * 0.75;
    const handPressurePenalty = -Math.pow(Math.max(0, totalTokens(after.tokens) - 7), 2) * 0.75;
    let buyBaseTempo = 0, buyEfficiency = 0, buyEfficiencyContribution = 0;
    if (action.type === 'BUY' && card) {
      const coloredSpent = COLOR_ORDER.reduce((sum, c) => sum + action.payment[c], 0);
      const effectiveCost = coloredSpent + action.payment.master * 2;
      const evolutionLink = card.evolvesToSpeciesId ? 1.5 : 0;
      const value = 2 + card.points * 4 + card.bonusAmount * 2 + evolutionLink;
      buyBaseTempo = 20;
      buyEfficiency = value / Math.max(1, effectiveCost);
      buyEfficiencyContribution = Math.min(60, buyEfficiency * 12);
    }
    const evolveAction = action.type === 'EVOLVE' ? 35 : 0;
    const skipEvolution = action.type === 'END_TURN' && moves.some(m => m.type === 'EVOLVE') ? -100 : 0;
    const crowdedReserve = action.type === 'RESERVE' && before.reserved.length >= 2 ? -8 : 0;
    const winThreshold = after.points >= WIN_THRESHOLD ? 160 : 0;
    let personality = 0;
    if (style === '抢分型') {
      personality += pointsGained * 18;
      if (after.points >= WIN_THRESHOLD) personality += 100;
      if (action.type === 'BUY' && card) personality += card.points * 5;
    } else if (style === '进化型') {
      personality += bonusGained * 10 + evolutionGained * 45;
      if (action.type === 'BUY' && card?.evolvesToSpeciesId) personality += 8;
      if (action.type === 'RESERVE' && card && before.purchased.some(c => c.evolvesToSpeciesId === card.speciesId)) personality += 18;
    } else {
      if (action.type === 'RESERVE' && card) personality += opponentDemand(state, card, idx) * 8 + card.points * 2;
      const leader = Math.max(...state.players.filter((_, i) => i !== idx).map(p => p.points));
      if (leader >= WIN_THRESHOLD - 4 && action.type === 'RESERVE' && card) personality += opponentDemand(state, card, idx) * 10;
      personality += pointsGained * 7;
    }
    const score = evaluation.total + pointsGained * 42 + bonusGained * 7 + evolutionGained * 30
      + targetProgressContribution + discardPenalty + idleTokenPenalty + handPressurePenalty
      + buyBaseTempo + buyEfficiencyContribution + evolveAction + skipEvolution + crowdedReserve + winThreshold + personality;
    ranked.push({
      action, score, diversityKey: publicOutcomeDiversityKey(state, afterState, after, action),
      terms: { evaluation, pointsGained: pointsGained * 42, bonusGained: bonusGained * 7, evolutionGained: evolutionGained * 30, targetProgress: progress, targetProgressContribution, discardPenalty, idleTokenCount, idleTokenPenalty, handPressurePenalty, buyBaseTempo, buyEfficiency, buyEfficiencyContribution, evolveAction, skipEvolution, crowdedReserve, winThreshold, personality, total: score },
      outcome: {
        pointsAfter: after.points, pointsGained, tokenCountAfter: totalTokens(after.tokens), bonusGained,
        evolvedAfter: after.evolved.length, evolutionGained, reservedAfter: after.reserved.length,
        mustDiscard: afterState.awaitingDiscard,
      },
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  return diverseSlice(ranked, limit);
}

export function candidateDebugLine(candidate: RankedCandidate, rank: number, state: GameState): string {
  return JSON.stringify({ rank, action: actionLabel(candidate.action, state), score: candidate.score, scorePrecision17: candidate.score.toPrecision(17), terms: candidate.terms, outcome: candidate.outcome });
}

export function candidateExplanation(candidate: RankedCandidate): string {
  const reasons: string[] = [];
  if (candidate.outcome.pointsGained > 0) reasons.push(`获得 ${candidate.outcome.pointsGained} 分`);
  if (candidate.outcome.evolutionGained > 0) reasons.push('完成免费进化');
  if (candidate.terms.targetProgress > 0) reasons.push(`推进重点目标 ${candidate.terms.targetProgress.toFixed(2)}`);
  if (candidate.terms.buyEfficiencyContribution > 0) reasons.push(`购买效率 ${candidate.terms.buyEfficiency.toFixed(2)}`);
  if (candidate.outcome.bonusGained > 0) reasons.push(`增加 ${candidate.outcome.bonusGained} 点永久资产`);
  if (candidate.terms.personality > 0) reasons.push(`人格偏好 +${candidate.terms.personality.toFixed(2)}`);
  if (!reasons.length) reasons.push('后继局面综合价值最高');
  return `规则评分 ${candidate.score.toFixed(2)}：${reasons.slice(0, 3).join('，')}。`;
}
