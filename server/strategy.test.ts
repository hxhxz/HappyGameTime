import { describe, expect, it } from 'vitest';
import { createGame, legalMoves } from '../src/engine';
import { CARDS } from '../src/data/cards';
import { DEFAULT_CANDIDATE_LIMIT, expectedAffordableCardValue, rankCandidates } from './strategy';

describe('hybrid candidate strategy', () => {
  it('returns a bounded, sorted and personality-weighted shortlist', () => {
    const game = createGame({ players: [0, 1, 2, 3].map(i => ({ id: `P${i}`, name: `P${i}`, isAI: true })), cards: CARDS, seed: 33 });
    game.currentPlayerIndex = 1;
    const moves = legalMoves(game);
    const scoring = rankCandidates(game, moves, '抢分型');
    const evolving = rankCandidates(game, moves, '进化型');
    const control = rankCandidates(game, moves, '控场型');
    for (const ranked of [scoring, evolving, control]) {
      expect(ranked.length).toBeGreaterThan(0);
      expect(ranked.length).toBeLessThanOrEqual(DEFAULT_CANDIDATE_LIMIT);
      expect(ranked.every((x, i) => i === 0 || ranked[i - 1].score >= x.score)).toBe(true);
      expect(ranked.every(x => Number.isFinite(x.score))).toBe(true);
      expect(ranked.every(x => x.terms.total === x.score)).toBe(true);
    }
    expect([scoring[0].score, evolving[0].score, control[0].score]).not.toEqual([scoring[0].score, scoring[0].score, scoring[0].score]);
    expect(new Set(scoring.map(x => x.action.type === 'TAKE_TWO' || x.action.type === 'TAKE_THREE' ? 'TAKE' : x.action.type))).toEqual(new Set(['TAKE', 'RESERVE']));
  });

  it('deduplicates identical actions before ranking', () => {
    const game = createGame({ players: [0, 1].map(i => ({ id: `P${i}`, name: `P${i}`, isAI: true })), cards: CARDS, seed: 7 });
    const move = legalMoves(game)[0];
    const ranked = rankCandidates(game, [move, structuredClone(move), move], '抢分型', 20);
    expect(ranked).toHaveLength(1);
  });

  it('caps continuous buy efficiency so free cards do not become another hard rule', () => {
    const game = createGame({ players: [0, 1].map(i => ({ id: `P${i}`, name: `P${i}`, isAI: true })), cards: CARDS, seed: 11 });
    const free = structuredClone(CARDS[0]);
    free.id = 'free-test-card'; free.cost = {};
    game.decks[1].faceUp[0] = free;
    const buy = legalMoves(game).find(m => m.type === 'BUY' && m.source.cardId === free.id);
    expect(buy).toBeTruthy();
    const [candidate] = rankCandidates(game, [buy!], '抢分型');
    expect(candidate.terms.buyEfficiencyContribution).toBe(60);
  });

  it('scores a refill by public deck expectation rather than the real next card', () => {
    const game = createGame({ players: [0, 1].map(i => ({ id: `P${i}`, name: `P${i}`, isAI: true })), cards: CARDS, seed: 19 });
    const target = structuredClone(game.decks[1].faceUp[0]!);
    target.cost = {};
    game.decks[1].faceUp[0] = target;
    const cheap = structuredClone(game.decks[1].drawPile[0]); cheap.cost = {}; cheap.points = 2;
    const expensive = structuredClone(game.decks[1].drawPile[1]); expensive.cost = { red: 99 }; expensive.points = 8;
    game.decks[1].drawPile = [cheap, expensive];
    const buy = legalMoves(game).find(m => m.type === 'BUY' && m.source.cardId === target.id)!;
    const afterPlayer = structuredClone(game.players[0]);
    afterPlayer.purchased.push(target);
    const first = expectedAffordableCardValue(game, afterPlayer, buy);
    const firstScore = rankCandidates(game, [buy], '抢分型')[0].score;
    game.decks[1].drawPile.reverse();
    const second = expectedAffordableCardValue(game, afterPlayer, buy);
    const secondScore = rankCandidates(game, [buy], '抢分型')[0].score;
    expect(first).toBe(second);
    expect(firstScore).toBe(secondScore);
    expect(first).toBeGreaterThanOrEqual((1 + cheap.points * 0.3) / 2);
  });
});
