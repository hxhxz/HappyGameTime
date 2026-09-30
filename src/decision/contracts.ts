import type { Action } from '../engine/types';
import type { CandidateEvidence, PlayerView } from './types';
import type { Rng } from '../engine/rng';

export interface HonestPolicy {
  readonly policyVersion: string;
  act(view: PlayerView, legalActions: Action[], rng: Rng): Action;
}

export interface HonestEvidenceProvider {
  readonly evidenceVersion: string;
  score(view: PlayerView, action: Action): CandidateEvidence;
}

export interface LlmRerankerInput {
  view: PlayerView;
  candidates: CandidateEvidence[];
}

export interface LlmRerankerResult {
  chosenIndex: number;
  explanation: string;
  rawResponse: unknown;
}

