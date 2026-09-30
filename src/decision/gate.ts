import type { Action } from '../engine/types';
import type { CandidateEvidence, CheapGateFeatures, PlayerView, RegretGate, RegretLabel, RegretPrediction } from './types';

const ACTION_TYPES: Action['type'][] = ['TAKE_THREE', 'TAKE_TWO', 'RESERVE', 'BUY', 'DISCARD', 'EVOLVE', 'END_TURN'];

export function cheapGateFeatures(view: PlayerView, candidates: CandidateEvidence[]): CheapGateFeatures {
  const scores = candidates.map(candidate => candidate.heuristic?.total ?? 0).sort((a, b) => b - a);
  const me = view.players.find(player => player.id === view.viewerId);
  if (!me) throw new Error('viewer missing from player view');
  const leader = Math.max(...view.players.filter(player => player.id !== me.id).map(player => player.points), me.points);
  const counts = Object.fromEntries(ACTION_TYPES.map(type => [type, 0])) as Record<Action['type'], number>;
  for (const candidate of candidates) counts[candidate.action.type]++;
  return {
    turn: view.turnNumber, phase: view.phase, legalActionCount: candidates.length,
    actionFamilyCounts: counts,
    topHeuristic: scores[0] ?? 0, secondHeuristic: scores[1] ?? scores[0] ?? 0,
    heuristicSpread: (scores[0] ?? 0) - (scores.at(-1) ?? 0),
    leaderGap: leader - me.points,
    tokenCount: Object.values(me.tokens).reduce((sum, n) => sum + n, 0),
    reserveCount: me.reservedCount,
    affordableCount: candidates.filter(candidate => candidate.action.type === 'BUY').length,
  };
}

export interface LinearRegretGateModel {
  version: string;
  intercept: number;
  threshold: number;
  weights: Partial<Record<keyof Omit<CheapGateFeatures, 'phase' | 'actionFamilyCounts'>, number>>;
  scales?: Partial<Record<keyof Omit<CheapGateFeatures, 'phase' | 'actionFamilyCounts'>, number>>;
}

const NUMERIC_FEATURES: Array<keyof Omit<CheapGateFeatures, 'phase' | 'actionFamilyCounts'>> = [
  'turn', 'legalActionCount', 'topHeuristic', 'secondHeuristic', 'heuristicSpread', 'leaderGap', 'tokenCount', 'reserveCount', 'affordableCount',
];

export interface RegretGateTrainingExample {
  episodeId: string;
  features: CheapGateFeatures;
  highRegret: boolean;
}

export function fitLinearRegretGate(examples: RegretGateTrainingExample[], options: { version: string; regretThreshold: number; iterations?: number; learningRate?: number }): LinearRegretGateModel {
  if (examples.length < 2) throw new Error('at least two regret examples are required');
  const episodes = new Set(examples.map(example => example.episodeId));
  if (!episodes.size) throw new Error('episode ids are required for leakage-safe splitting');
  const weights = Object.fromEntries(NUMERIC_FEATURES.map(key => [key, 0])) as LinearRegretGateModel['weights'];
  let intercept = 0;
  const iterations = options.iterations ?? 300;
  const learningRate = options.learningRate ?? 0.05;
  const scale = Object.fromEntries(NUMERIC_FEATURES.map(key => [key, Math.max(1, ...examples.map(example => Math.abs(example.features[key])))])) as Record<typeof NUMERIC_FEATURES[number], number>;
  for (let iteration = 0; iteration < iterations; iteration++) {
    let interceptGradient = 0;
    const gradients = Object.fromEntries(NUMERIC_FEATURES.map(key => [key, 0])) as Record<typeof NUMERIC_FEATURES[number], number>;
    for (const example of examples) {
      let z = intercept;
      for (const key of NUMERIC_FEATURES) z += (weights[key] ?? 0) * example.features[key] / scale[key];
      const probability = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const error = probability - Number(example.highRegret);
      interceptGradient += error;
      for (const key of NUMERIC_FEATURES) gradients[key] += error * example.features[key] / scale[key];
    }
    intercept -= learningRate * interceptGradient / examples.length;
    for (const key of NUMERIC_FEATURES) weights[key] = (weights[key] ?? 0) - learningRate * gradients[key] / examples.length;
  }
  return { version: options.version, intercept, threshold: options.regretThreshold, weights, scales: scale };
}

export function calibrateProbabilityThreshold(predictions: Array<{ probability: number; highRegret: boolean }>, minimumRecall: number, maximumCoverage: number): number {
  if (!predictions.some(item => item.highRegret)) throw new Error('calibration requires high-regret examples');
  const thresholds = [...new Set(predictions.map(item => item.probability))].sort((a, b) => b - a);
  let selected = 1;
  for (const threshold of thresholds) {
    const chosen = predictions.filter(item => item.probability >= threshold);
    const positives = predictions.filter(item => item.highRegret).length;
    const recall = chosen.filter(item => item.highRegret).length / positives;
    const coverage = chosen.length / predictions.length;
    if (recall >= minimumRecall && coverage <= maximumCoverage) selected = Math.min(selected, threshold);
  }
  return selected;
}

export function linearRegretGate(model: LinearRegretGateModel): RegretGate {
  return {
    predict(features): RegretPrediction {
      let z = model.intercept;
      for (const [key, weight] of Object.entries(model.weights)) {
        const typed = key as keyof typeof model.weights;
        z += (features[typed] as number) / (model.scales?.[typed] ?? 1) * (weight ?? 0);
      }
      const probability = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      return { expectedRegret: probability * model.threshold, highRegretProbability: probability, modelVersion: model.version };
    },
  };
}

export const DISABLED_REGRET_GATE: RegretGate = {
  predict: () => ({ expectedRegret: 0, highRegretProbability: 0, modelVersion: 'disabled-v1' }),
};

export function validateRegretTrainingLabels(labels: RegretLabel[]): RegretLabel[] {
  return labels.filter(label => label.labelQuality === 'high' && label.rolloutPairs > 1 && Number.isFinite(label.expectedRegret));
}
