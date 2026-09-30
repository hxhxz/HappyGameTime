import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyAction, passTurn, type GameState } from '../src/engine';
import { deserializeState } from '../src/net/serialize';
import { artifactIdentity, stableHash } from '../src/decision/identity';
import type { CheapGateFeatures, RegretLabel } from '../src/decision/types';
import type { EpisodeRecord } from '../src/decision/replay';
import { cheapGateFeatures, calibrateProbabilityThreshold, fitLinearRegretGate, linearRegretGate, type LinearRegretGateModel, type RegretGateTrainingExample } from '../src/decision/gate';
import { buildCandidatePipeline } from './policy-runtime';
import { labelDecisionRegret } from './regret';

interface RegretRow { episodeId: string; features: CheapGateFeatures; label: RegretLabel }
interface SplitRow extends RegretRow { split: 'train' | 'calibration' | 'test' }

function args(): { command: string; values: Map<string, string> } {
  const [, , command = '', ...rest] = process.argv;
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) throw new Error(`invalid argument: ${rest[i]}`);
    values.set(rest[i].slice(2), rest[i + 1]);
  }
  return { command, values };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function files(path: string): string[] {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`input does not exist: ${absolute}`);
  return statSync(absolute).isDirectory() ? readdirSync(absolute).filter(name => name.endsWith('.json')).map(name => resolve(absolute, name)) : [absolute];
}

function readEpisodes(path: string): EpisodeRecord[] {
  return files(path).map(file => {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    const episode = (value.episode ?? value) as EpisodeRecord;
    episode.initialState = deserializeState(JSON.stringify(episode.initialState));
    if (!episode.artifact || !episode.episodeId) throw new Error(`${file} is not a versioned episode artifact`);
    return episode;
  });
}

function readJsonLines<T>(path: string): T[] {
  return readFileSync(resolve(path), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}

function writeJsonLines(path: string, rows: unknown[]): void {
  writeFileSync(resolve(path), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
}

function splitOf(episodeId: string): SplitRow['split'] {
  const bucket = Number.parseInt(stableHash(episodeId).slice(0, 8), 16) % 10;
  return bucket < 7 ? 'train' : bucket < 9 ? 'calibration' : 'test';
}

function label(values: Map<string, string>): void {
  const input = required(values, 'input');
  const output = required(values, 'output');
  const rolloutPairs = Number(values.get('pairs') ?? 16);
  const threshold = Number(values.get('threshold') ?? 0.2);
  const maxDecisions = Number(values.get('max-decisions') ?? Number.POSITIVE_INFINITY);
  const rows: RegretRow[] = [];
  for (const episode of readEpisodes(input)) {
    let state: GameState = structuredClone(episode.initialState);
    for (const step of episode.steps) {
      if (rows.length >= maxDecisions) break;
      if (!step.chosenAction) { state = passTurn(state); continue; }
      const pipeline = buildCandidatePipeline(state, step.legalActions, 'neutral', step.legalActions.length);
      const baselineAction = pipeline.ranked[0]?.action;
      if (!baselineAction) { state = applyAction(state, step.chosenAction); continue; }
      const artifact = artifactIdentity({ source: episode.artifact, rolloutPairs, threshold, continuation: 'heuristic-honest' }, process.env.CODE_REVISION || 'development');
      const decisionId = `${episode.episodeId}:${step.t}`;
      rows.push({
        episodeId: episode.episodeId,
        features: cheapGateFeatures(pipeline.view, pipeline.evidence),
        label: labelDecisionRegret(state, {
          artifact, decisionId, baselineAction, rolloutPairs,
          seed: state.rngSeed ^ step.t, highRegretThreshold: threshold,
        }),
      });
      state = applyAction(state, step.chosenAction);
    }
  }
  writeJsonLines(output, rows);
}

function split(values: Map<string, string>): void {
  const rows = readJsonLines<RegretRow>(required(values, 'input'));
  writeJsonLines(required(values, 'output'), rows.map(row => ({ ...row, split: splitOf(row.episodeId) })));
}

function train(values: Map<string, string>): void {
  const threshold = Number(values.get('threshold') ?? 0.2);
  const rows = readJsonLines<SplitRow>(required(values, 'input')).filter(row => row.split === 'train' && row.label.labelQuality === 'high');
  const examples: RegretGateTrainingExample[] = rows.map(row => ({ episodeId: row.episodeId, features: row.features, highRegret: row.label.expectedRegret >= threshold }));
  const model = fitLinearRegretGate(examples, { version: values.get('version') ?? 'regret-gate-v1', regretThreshold: threshold });
  const artifact = artifactIdentity({ sources: [...new Set(rows.map(row => row.label.artifact.configHash))], threshold, model }, process.env.CODE_REVISION || 'development');
  writeFileSync(resolve(required(values, 'output')), JSON.stringify({ artifact, model }, null, 2), { mode: 0o600 });
}

function loadModel(path: string): LinearRegretGateModel {
  const value = JSON.parse(readFileSync(resolve(path), 'utf8'));
  return (value.model ?? value) as LinearRegretGateModel;
}

function calibrate(values: Map<string, string>): void {
  const rows = readJsonLines<SplitRow>(required(values, 'input')).filter(row => row.split === 'calibration' && row.label.labelQuality === 'high');
  const model = loadModel(required(values, 'model'));
  const gate = linearRegretGate(model);
  const predictions = rows.map(row => ({ probability: gate.predict(row.features).highRegretProbability, highRegret: row.label.expectedRegret >= model.threshold }));
  const probabilityThreshold = calibrateProbabilityThreshold(predictions, Number(values.get('minimum-recall') ?? .8), Number(values.get('maximum-coverage') ?? .2));
  writeFileSync(resolve(required(values, 'output')), JSON.stringify({ artifact: artifactIdentity({ model, probabilityThreshold }, process.env.CODE_REVISION || 'development'), probabilityThreshold }, null, 2), { mode: 0o600 });
}

function evaluate(values: Map<string, string>): void {
  const rows = readJsonLines<SplitRow>(required(values, 'input')).filter(row => row.split === 'test' && row.label.labelQuality === 'high');
  const model = loadModel(required(values, 'model'));
  const gate = linearRegretGate(model);
  const probabilityThreshold = Number(values.get('probability-threshold') ?? .5);
  let tp = 0, fp = 0, fn = 0;
  for (const row of rows) {
    const predicted = gate.predict(row.features).highRegretProbability >= probabilityThreshold;
    const actual = row.label.expectedRegret >= model.threshold;
    if (predicted && actual) tp++; else if (predicted) fp++; else if (actual) fn++;
  }
  const report = { artifact: artifactIdentity({ model, probabilityThreshold, rows: rows.length }, process.env.CODE_REVISION || 'development'), rows: rows.length, precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn), coverage: (tp + fp) / Math.max(1, rows.length), tp, fp, fn };
  writeFileSync(resolve(required(values, 'output')), JSON.stringify(report, null, 2), { mode: 0o600 });
}

const { command, values } = args();
if (command === 'label') label(values);
else if (command === 'split') split(values);
else if (command === 'train') train(values);
else if (command === 'calibrate') calibrate(values);
else if (command === 'evaluate') evaluate(values);
else throw new Error('usage: regret-cli <label|split|train|calibrate|evaluate> --input ... --output ...');
