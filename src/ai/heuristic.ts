// 启发式 AI:可调权重的线性评估 + 1-ply 贪心。权重可由自对弈训练(sim/train.ts)调优。
import { applyAction, buildBuyAction, colorVectorMeets, type GameState } from '../engine';
import { ALL_PILES, COLOR_ORDER, WIN_THRESHOLD } from '../engine/types';
import type { Policy } from './policies';

export interface Weights {
  points: number;      // 分数(主目标)
  bonus: number;       // 永久折扣引擎(早期更值,随分数衰减)
  pp: number;          // 购买力(手牌+折扣,封顶)
  afford: number;      // 当前可买的场上卡(按分数加权)
  evoReady: number;    // 已可立即进化的已购卡
  evoSetup: number;    // 有进化目标但加成未满足
  reserve: number;     // 预订张数(锁卡 + 得大师球)
  endgame: number;     // 终局期对分数的额外放大
}

export interface EvaluationTerms {
  points: number;
  totalBonus: number;
  bonusDecay: number;
  bonus: number;
  purchasingPower: number;
  pp: number;
  affordableCardValue: number;
  afford: number;
  evoReadyCount: number;
  evoReady: number;
  evoSetupCount: number;
  evoSetup: number;
  reservedCount: number;
  reserve: number;
  endgameActive: boolean;
  endgame: number;
  total: number;
}

// 训练后的默认权重(初始为人工先验,train 会覆盖)
export const DEFAULT_WEIGHTS: Weights = {
  // Keep secondary terms visible beside the tactical ranker without allowing
  // any one of them to become another hard action rule.
  points: 16, bonus: 4.16, pp: 0.25, afford: 0.75, evoReady: 5, evoSetup: 1.5, reserve: 0.75, endgame: 6,
};

export function evaluationTerms(state: GameState, idx: number, w: Weights, overrides: { affordableCardValue?: number } = {}): EvaluationTerms {
  const me = state.players[idx];
  const points = w.points * me.points;

  let totalBonus = 0;
  for (const c of COLOR_ORDER) totalBonus += me.bonuses[c];
  const bonusDecay = Math.max(0.05, 1 - me.points / WIN_THRESHOLD);
  const bonus = w.bonus * totalBonus * bonusDecay;

  let purchasingPower = me.tokens.master;
  for (const c of COLOR_ORDER) purchasingPower += Math.min(6, me.tokens[c] + me.bonuses[c]);
  const pp = w.pp * purchasingPower;

  let affordableCardValue = overrides.affordableCardValue;
  if (affordableCardValue === undefined) {
    affordableCardValue = 0;
    for (const pile of ALL_PILES) {
      for (const card of state.decks[pile].faceUp) {
        if (card && buildBuyAction(me, card, { kind: 'board', cardId: card.id })) affordableCardValue += 1 + card.points * 0.3;
      }
    }
  }
  let evoReadyCount = 0, evoSetupCount = 0;
  for (const x of me.purchased) {
    if (x.kind === 'normal' && x.stage < 3 && x.evolvesToSpeciesId && x.evolveCost) {
      if (colorVectorMeets(me.bonuses, x.evolveCost)) evoReadyCount += 1; else evoSetupCount += 1;
    }
  }
  const afford = w.afford * affordableCardValue;
  const evoReady = w.evoReady * evoReadyCount;
  const evoSetup = w.evoSetup * evoSetupCount;
  const reservedCount = me.reserved.length;
  const reserve = w.reserve * reservedCount;

  const maxAny = Math.max(...state.players.map((p) => p.points));
  const endgameActive = maxAny >= WIN_THRESHOLD - 3;
  const endgame = endgameActive ? w.endgame * me.points : 0;
  const total = points + bonus + pp + afford + evoReady + evoSetup + reserve + endgame;

  return { points, totalBonus, bonusDecay, bonus, purchasingPower, pp, affordableCardValue, afford, evoReadyCount, evoReady, evoSetupCount, evoSetup, reservedCount, reserve, endgameActive, endgame, total };
}

export function evaluate(state: GameState, idx: number, w: Weights): number {
  return evaluationTerms(state, idx, w).total;
}

/** 1-ply 贪心:对每个合法动作模拟一步,用 evaluate 取最高(从行动者视角)。 */
export function heuristicPolicy(w: Weights = DEFAULT_WEIGHTS): Policy {
  return (moves, state, rng) => {
    const idx = state.currentPlayerIndex;
    // greedy 纪律:能买就买(避免囤积被动),但「买哪张」由 eval 决定(更看 bonus 色/进化);
    // 无可买时再用 eval 在取币/预订/进化/弃牌里挑(把取币导向能尽快买到好卡)。
    const buys = moves.filter((m) => m.type === 'BUY');
    const pool = state.awaitingDiscard || state.awaitingEvolve ? moves : buys.length > 0 ? buys : moves;
    let best = pool[0];
    let bestScore = -Infinity;
    for (const m of pool) {
      let ns: GameState;
      try { ns = applyAction(state, m); } catch { continue; }
      const sc = evaluate(ns, idx, w) + rng.next() * 0.001;
      if (sc > bestScore) { bestScore = sc; best = m; }
    }
    return best;
  };
}
