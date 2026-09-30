import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyAction, passTurn } from '../src/engine';
import { deserializeState } from '../src/net/serialize';
import { artifactIdentity } from '../src/decision/identity';
import { publicView } from '../src/decision/views';
import type { EpisodeRecord } from '../src/decision/replay';
import type { OpponentTeacherLabel } from '../src/decision/types';
import { llmProvider, modelSettings } from './platform';
import { distillFrequencyStudent, frequencyOpponentStudent } from './opponent-student';

function parse(): { command: string; values: Map<string, string> } {
  const [, , command = '', ...rest] = process.argv;
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) values.set(rest[i].replace(/^--/, ''), rest[i + 1]);
  return { command, values };
}
const need = (values: Map<string, string>, key: string) => { const value = values.get(key); if (!value) throw new Error(`--${key} is required`); return value; };
const readLines = <T>(path: string): T[] => readFileSync(resolve(path), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
const writeLines = (path: string, rows: unknown[]) => writeFileSync(resolve(path), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });

async function label(values: Map<string, string>): Promise<void> {
  const exported = JSON.parse(readFileSync(resolve(need(values, 'input')), 'utf8'));
  const episode = (exported.episode ?? exported) as EpisodeRecord;
  episode.initialState = deserializeState(JSON.stringify(episode.initialState));
  const profileId = need(values, 'model-profile');
  const settings = modelSettings(profileId);
  const provider = llmProvider(profileId);
  const limit = Number(values.get('max-decisions') ?? 100);
  let state = structuredClone(episode.initialState);
  const labels: OpponentTeacherLabel[] = [];
  for (const step of episode.steps) {
    if (labels.length >= limit) break;
    if (!step.chosenAction) { state = passTurn(state); continue; }
    const input = { publicView: publicView(state), publicHistory: state.log.slice(-8), opponentId: step.playerId, revealedBehaviorFeatures: {}, legalActions: step.legalActions };
    const messages = [
      { role: 'system', content: 'Estimate this player’s next-action distribution using only public information. Return JSON {"probabilities":[{"actionIndex":0,"probability":0.5}]} covering legal action indexes.' },
      { role: 'user', content: JSON.stringify(input) },
    ];
    const response = await provider.complete({ model: settings.model, messages, sampling: { temperature: 0 }, timeoutMs: 60_000 });
    const parsed = JSON.parse(response.text) as { probabilities?: Array<{ actionIndex: number; probability: number }> };
    const probabilities = (parsed.probabilities ?? []).filter(item => Number.isInteger(item.actionIndex) && step.legalActions[item.actionIndex] && item.probability >= 0).map(item => ({ action: step.legalActions[item.actionIndex], probability: item.probability }));
    if (!probabilities.length) throw new Error(`teacher returned no valid probabilities at step ${step.t}`);
    labels.push({ input, distribution: { modelVersion: settings.model, probabilities }, teacherModelProfileId: profileId, promptProfileId: 'opponent-public-v1' });
    state = applyAction(state, step.chosenAction);
  }
  writeLines(need(values, 'output'), labels);
}

function train(values: Map<string, string>): void {
  const labels = readLines<OpponentTeacherLabel>(need(values, 'input'));
  const model = distillFrequencyStudent(labels, values.get('version') ?? 'opponent-student-v2');
  writeFileSync(resolve(need(values, 'output')), JSON.stringify({ artifact: artifactIdentity({ labels: labels.length, model }, process.env.CODE_REVISION || 'development'), model }, null, 2), { mode: 0o600 });
}

function evaluate(values: Map<string, string>): void {
  const labels = readLines<OpponentTeacherLabel>(need(values, 'input'));
  const stored = JSON.parse(readFileSync(resolve(need(values, 'model')), 'utf8'));
  const student = frequencyOpponentStudent(stored.model ?? stored);
  let crossEntropy = 0;
  for (const label of labels) {
    const predicted = student.predict(label.input);
    for (const target of label.distribution.probabilities) {
      const probability = predicted.probabilities.find(item => JSON.stringify(item.action) === JSON.stringify(target.action))?.probability ?? 1e-9;
      crossEntropy -= target.probability * Math.log(Math.max(1e-9, probability));
    }
  }
  const report = { artifact: artifactIdentity({ model: student.predict(labels[0].input).modelVersion, labels: labels.length }, process.env.CODE_REVISION || 'development'), labels: labels.length, meanCrossEntropy: crossEntropy / Math.max(1, labels.length) };
  writeFileSync(resolve(need(values, 'output')), JSON.stringify(report, null, 2), { mode: 0o600 });
}

const { command, values } = parse();
if (command === 'label') await label(values);
else if (command === 'train') train(values);
else if (command === 'evaluate') evaluate(values);
else throw new Error('usage: opponent-cli <label|train|evaluate> ...');

