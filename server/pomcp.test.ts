import { describe, expect, it } from 'vitest';
import { createGame, legalMoves } from '../src/engine';
import { CARDS } from '../src/data/cards';
import { pomcpHonest, uniformOpponentStudent } from './pomcp';

describe('POMCP honest search', () => {
  it('returns a legal action and public-history search evidence', () => {
    const state = createGame({ players: [0, 1].map(i => ({ id: `P${i}`, name: `P${i}`, isAI: true })), cards: CARDS, seed: 3 });
    const result = pomcpHonest(state, { simulations: 12, ownTurns: 1, seed: 9, opponent: uniformOpponentStudent });
    expect(legalMoves(state)).toContainEqual(result.action);
    expect(result.depthPly).toBe(2);
    expect([...result.evidence.values()].reduce((sum, evidence) => sum + evidence.visits, 0)).toBe(12);
    expect([...result.evidence.values()].every(evidence => evidence.searchVersion.includes('honest'))).toBe(true);
  });
});

