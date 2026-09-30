import type { Action, GameState } from '../src/engine';
import type { CandidateEvidence, HeuristicEvidence } from '../src/decision/types';
import { playerView } from '../src/decision/views';
import { applyPersonaPreference, scoreCandidates, type PersonaMode, type RankedCandidate } from './strategy';
import { DEFAULT_WEIGHTS, type Weights } from '../src/ai/heuristic';

function flatten(value: unknown, prefix = '', out: Record<string, number | boolean> = {}): Record<string, number | boolean> {
  if (typeof value === 'number' || typeof value === 'boolean') { out[prefix || 'value'] = value; return out; }
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value as Record<string, unknown>)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  return out;
}

export interface CandidatePipelineResult {
  view: ReturnType<typeof playerView>;
  ranked: RankedCandidate[];
  evidence: CandidateEvidence[];
}

export function buildCandidatePipeline(state: GameState, legal: Action[], personaMode: PersonaMode = 'neutral', limit = 8, weights: Weights = DEFAULT_WEIGHTS): CandidatePipelineResult {
  const neutral = scoreCandidates(state, legal, weights);
  const ranked = applyPersonaPreference(state, neutral, personaMode).slice(0, limit);
  const evidence = ranked.map(candidate => ({
    action: candidate.action,
    heuristic: { terms: flatten(candidate.terms), total: candidate.score, mode: 'marginalized' } satisfies HeuristicEvidence,
  }));
  return { view: playerView(state), ranked, evidence };
}
