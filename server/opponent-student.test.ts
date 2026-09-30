import { describe, expect, it } from 'vitest';
import { createGame, legalMoves } from '../src/engine';
import { CARDS } from '../src/data/cards';
import { publicView } from '../src/decision/views';
import type { OpponentTeacherLabel } from '../src/decision/types';
import { distillFrequencyStudent, frequencyOpponentStudent } from './opponent-student';

describe('offline LLM teacher to local opponent student', () => {
  it('distills a normalized local distribution without private sampled hands', () => {
    const state = createGame({ players: [0, 1].map(i => ({ id: `P${i}`, name: `P${i}`, isAI: true })), cards: CARDS, seed: 8 });
    const legal = legalMoves(state);
    const label: OpponentTeacherLabel = {
      input: { publicView: publicView(state), publicHistory: [], opponentId: 'P0', revealedBehaviorFeatures: {}, legalActions: legal },
      distribution: { modelVersion: 'teacher', probabilities: legal.map((action, index) => ({ action, probability: index ? 0 : 1 })) },
      teacherModelProfileId: 'teacher-a', promptProfileId: 'opponent-v1',
    };
    const student = frequencyOpponentStudent(distillFrequencyStudent([label]));
    const output = student.predict(label.input);
    expect(output.probabilities.reduce((sum, item) => sum + item.probability, 0)).toBeCloseTo(1);
    expect(JSON.stringify(label.input)).not.toContain('drawPile');
  });
});

