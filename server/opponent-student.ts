import type { Action } from '../src/engine/types';
import type { ActionDistribution, OpponentModelInput, OpponentStudent, OpponentTeacherLabel } from '../src/decision/types';

const FAMILIES: Action['type'][] = ['TAKE_THREE', 'TAKE_TWO', 'RESERVE', 'BUY', 'DISCARD', 'EVOLVE', 'END_TURN'];

export interface FrequencyStudentModel {
  version: string;
  familyWeights: Record<Action['type'], number>;
  teacherProfiles: string[];
}

export function distillFrequencyStudent(labels: OpponentTeacherLabel[], version = 'opponent-student-v1'): FrequencyStudentModel {
  if (!labels.length) throw new Error('teacher labels are required');
  const totals = Object.fromEntries(FAMILIES.map(type => [type, 1])) as Record<Action['type'], number>;
  for (const label of labels) {
    for (const item of label.distribution.probabilities) totals[item.action.type] += Math.max(0, item.probability);
  }
  const sum = Object.values(totals).reduce((acc, value) => acc + value, 0);
  return {
    version, familyWeights: Object.fromEntries(FAMILIES.map(type => [type, totals[type] / sum])) as Record<Action['type'], number>,
    teacherProfiles: [...new Set(labels.map(label => label.teacherModelProfileId))],
  };
}

export function frequencyOpponentStudent(model: FrequencyStudentModel): OpponentStudent {
  return {
    predict(input: OpponentModelInput): ActionDistribution {
      const raw = input.legalActions.map(action => ({ action, probability: model.familyWeights[action.type] }));
      const total = raw.reduce((sum, item) => sum + item.probability, 0);
      return { modelVersion: model.version, probabilities: raw.map(item => ({ ...item, probability: item.probability / total })) };
    },
  };
}

