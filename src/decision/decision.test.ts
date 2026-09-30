import { describe, expect, it } from 'vitest';
import { applyAction, createGame, legalMoves } from '../engine';
import { CARDS } from '../data/cards';
import { assertDatasetAllowed, assertHonestCheckpoint, checkpointInformationClass } from './dataset';
import { appendReplayStep, newEpisodeRecord, replayEpisode } from './replay';
import { playerView, publicView, viewHash } from './views';
import { calibrateProbabilityThreshold, fitLinearRegretGate, linearRegretGate, type RegretGateTrainingExample } from './gate';
import type { CheapGateFeatures } from './types';
import { artifactIdentity, batchEpisodeId } from './identity';

const game = () => createGame({
  players: [0, 1].map(index => ({ id: `P${index}`, name: `P${index}`, isAI: index > 0 })),
  cards: CARDS, seed: 42,
});

describe('honest decision boundary', () => {
  it('projects hidden state out of public and player views', () => {
    const state = game();
    const pub = publicView(state);
    const mine = playerView(state, 0);
    expect(JSON.stringify(pub)).not.toContain('drawPile');
    expect(JSON.stringify(pub)).not.toContain('rngSeed');
    expect(JSON.stringify(pub)).not.toContain(state.decks[1].drawPile[0].id);
    expect(mine.privateReserved).toEqual([]);
    expect(viewHash(mine)).toBe(viewHash(playerView(state, 0)));
  });

  it('replays every action with matching legal set, view hash and observation', () => {
    let state = game();
    const record = newEpisodeRecord('test', state, artifactIdentity({ test: true }, 'test-revision'));
    for (let i = 0; i < 5 && !state.isGameOver; i++) {
      const action = legalMoves(state)[0];
      const next = applyAction(state, action);
      appendReplayStep(record, state, action, next);
      state = next;
    }
    expect(replayEpisode(record)).toEqual(state);
  });

  it('derives stable batch episode and artifact identities without wall-clock time', () => {
    const input = { experimentId: 'exp', seed: 7, replicateIndex: 0, seatRotation: 2 };
    expect(batchEpisodeId(input)).toBe(batchEpisodeId(input));
    expect(artifactIdentity(input, 'abc')).toEqual(artifactIdentity(input, 'abc'));
  });

  it('blocks oracle data and checkpoints from honest training', () => {
    const honest = { informationClass: 'honest_partial' as const, allowedPurposes: ['regret_gate' as const], sourceExperimentIds: ['e1'] };
    const oracle = { informationClass: 'oracle_full' as const, allowedPurposes: ['oracle_baseline' as const], sourceExperimentIds: ['e2'] };
    expect(() => assertDatasetAllowed(honest, 'regret_gate')).not.toThrow();
    expect(() => assertDatasetAllowed(oracle, 'honest_policy')).toThrow(/does not allow|cannot train/);
    expect(checkpointInformationClass([honest, oracle])).toBe('oracle_full');
    expect(() => assertHonestCheckpoint('oracle_full')).toThrow(/oracle checkpoint/);
  });

  it('fits and calibrates a cheap regret gate without search features', () => {
    const features = (leaderGap: number): CheapGateFeatures => ({
      turn: 10, phase: 'main', legalActionCount: 4,
      actionFamilyCounts: { TAKE_THREE: 1, TAKE_TWO: 1, RESERVE: 1, BUY: 1, DISCARD: 0, EVOLVE: 0, END_TURN: 0 },
      topHeuristic: 2, secondHeuristic: 1, heuristicSpread: 2, leaderGap,
      tokenCount: 5, reserveCount: 0, affordableCount: 1,
    });
    const examples: RegretGateTrainingExample[] = [0, 0, 8, 10].map((gap, index) => ({ episodeId: `e${index}`, features: features(gap), highRegret: gap > 5 }));
    const model = fitLinearRegretGate(examples, { version: 'test', regretThreshold: 0.2, iterations: 600 });
    const gate = linearRegretGate(model);
    expect(gate.predict(features(10)).highRegretProbability).toBeGreaterThan(gate.predict(features(0)).highRegretProbability);
    expect(calibrateProbabilityThreshold([{ probability: .9, highRegret: true }, { probability: .8, highRegret: true }, { probability: .2, highRegret: false }], .5, .8)).toBeGreaterThanOrEqual(.8);
  });
});
