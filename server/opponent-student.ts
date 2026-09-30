import type { Action } from '../src/engine/types';
import type { ActionDistribution, OpponentModelInput, OpponentStudent, OpponentTeacherLabel } from '../src/decision/types';

const FAMILIES: Action['type'][] = ['TAKE_THREE', 'TAKE_TWO', 'RESERVE', 'BUY', 'DISCARD', 'EVOLVE', 'END_TURN'];

export interface FrequencyStudentModel {
  version: string;
  defaultWeights: Record<Action['type'], number>;
  bucketWeights: Record<string, Record<Action['type'], number>>;
  teacherProfiles: string[];
}

function bucket(input: OpponentModelInput): string {
  const opponent = input.publicView.players.find(player => player.id === input.opponentId);
  const leader = Math.max(...input.publicView.players.map(player => player.points));
  const phase = input.publicView.phase;
  const turn = Math.floor(input.publicView.turnNumber / 8);
  const gap = Math.min(2, Math.max(0, Math.floor((leader - (opponent?.points ?? 0)) / 4)));
  return `${phase}:t${turn}:g${gap}`;
}

function normalized(counts: Record<Action['type'], number>): Record<Action['type'], number> {
  const sum = Object.values(counts).reduce((acc, value) => acc + value, 0);
  return Object.fromEntries(FAMILIES.map(type => [type, counts[type] / sum])) as Record<Action['type'], number>;
}

export function distillFrequencyStudent(labels: OpponentTeacherLabel[], version = 'opponent-student-v1'): FrequencyStudentModel {
  if (!labels.length) throw new Error('teacher labels are required');
  const totals = Object.fromEntries(FAMILIES.map(type => [type, 1])) as Record<Action['type'], number>;
  const buckets: Record<string, Record<Action['type'], number>> = {};
  for (const label of labels) {
    const key = bucket(label.input);
    const counts = buckets[key] ??= Object.fromEntries(FAMILIES.map(type => [type, 1])) as Record<Action['type'], number>;
    for (const item of label.distribution.probabilities) {
      const probability = Math.max(0, item.probability);
      totals[item.action.type] += probability;
      counts[item.action.type] += probability;
    }
  }
  return {
    version, defaultWeights: normalized(totals), bucketWeights: Object.fromEntries(Object.entries(buckets).map(([key, counts]) => [key, normalized(counts)])),
    teacherProfiles: [...new Set(labels.map(label => label.teacherModelProfileId))],
  };
}

export function frequencyOpponentStudent(model: FrequencyStudentModel): OpponentStudent {
  return {
    modelVersion: model.version,
    predict(input: OpponentModelInput): ActionDistribution {
      const weights = model.bucketWeights[bucket(input)] ?? model.defaultWeights;
      const raw = input.legalActions.map(action => ({ action, probability: weights[action.type] }));
      const total = raw.reduce((sum, item) => sum + item.probability, 0);
      return { modelVersion: model.version, probabilities: raw.map(item => ({ ...item, probability: item.probability / total })) };
    },
  };
}
