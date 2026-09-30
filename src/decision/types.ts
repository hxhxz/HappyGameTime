import type { Action, Card, ColorVector, Cost, GameState, PayableToken, PileKey, TokenPool } from '../engine/types';

export const ENV_VERSION = 'decision-platform-v1';

export type InformationClass = 'honest_partial' | 'oracle_full';
export type EvidenceMode = 'masked' | 'marginalized';

export interface VisibleCard {
  id: string;
  name: string;
  kind: Card['kind'];
  stage: Card['stage'];
  points: number;
  cost: Cost;
  bonus: Card['bonus'];
  bonusAmount: number;
  speciesId: string;
  evolvesToSpeciesId?: string;
}

export interface PublicPlayerView {
  id: string;
  name: string;
  tokens: TokenPool;
  purchased: VisibleCard[];
  evolvedCount: number;
  reservedCount: number;
  bonuses: ColorVector;
  points: number;
}

export interface PublicDeckView {
  key: PileKey;
  remaining: number;
  faceUp: Array<VisibleCard | null>;
}

export interface PublicView {
  currentPlayerIndex: number;
  tokenPool: TokenPool;
  decks: PublicDeckView[];
  players: PublicPlayerView[];
  turnNumber: number;
  phase: 'main' | 'discard' | 'evolve' | 'finished';
  isGameOver: boolean;
  winnerId?: string;
  recentPublicHistory: string[];
}

export interface PlayerView extends PublicView {
  viewerId: string;
  privateReserved: VisibleCard[];
}

/** Deliberately separate from PlayerView. It must never implement HonestPolicy input. */
export interface OracleView {
  informationClass: 'oracle_full';
  state: GameState;
}

export type PolicyView =
  | { condition: 'partial'; view: PlayerView }
  | { condition: 'full_experimental'; view: OracleView };

export interface HeuristicEvidence {
  terms: Record<string, number | boolean>;
  total: number;
  mode: EvidenceMode;
}

export interface SearchEvidence {
  visits: number;
  meanQ: number;
  uncertainty: number;
  searchVersion: string;
}

export interface LearnedEvidence {
  modelVersion: string;
  predictedV?: number;
  actionScore?: number;
  confidence?: number;
}

/** Oracle-only evidence is intentionally excluded from CandidateEvidence. */
export interface ExperimentalOracleEvidence {
  informationClass: 'oracle_full';
  terms: Record<string, number>;
  total: number;
  experimentId: string;
}

export interface CandidateEvidence {
  action: Action;
  heuristic?: HeuristicEvidence;
  search?: SearchEvidence;
  learned?: LearnedEvidence;
}

export interface RegretLabel {
  decisionId: string;
  baselineAction: Action;
  bestAction: Action;
  expectedRegret: number;
  ciLow: number;
  ciHigh: number;
  rolloutPairs: number;
  labelQuality: 'high' | 'uncertain';
  utilityDefinition: string;
  evaluatorVersion: string;
}

export interface CheapGateFeatures {
  turn: number;
  phase: PublicView['phase'];
  legalActionCount: number;
  actionFamilyCounts: Record<Action['type'], number>;
  topHeuristic: number;
  secondHeuristic: number;
  heuristicSpread: number;
  leaderGap: number;
  tokenCount: number;
  reserveCount: number;
  affordableCount: number;
}

export interface RegretPrediction {
  expectedRegret: number;
  highRegretProbability: number;
  modelVersion: string;
}

export interface RegretGate {
  predict(input: CheapGateFeatures): RegretPrediction;
}

export interface DatasetManifest {
  informationClass: InformationClass;
  allowedPurposes: Array<'honest_policy' | 'regret_gate' | 'opponent_student' | 'oracle_baseline'>;
  sourceExperimentIds: string[];
}

export interface OpponentModelInput {
  publicView: PublicView;
  publicHistory: string[];
  opponentId: string;
  revealedBehaviorFeatures: Record<string, number>;
  legalActions: Action[];
}

export interface ActionDistribution {
  probabilities: Array<{ action: Action; probability: number }>;
  modelVersion: string;
}

export interface OpponentTeacherLabel {
  input: OpponentModelInput;
  distribution: ActionDistribution;
  teacherModelProfileId: string;
  promptProfileId: string;
}

export interface OpponentStudent {
  predict(input: OpponentModelInput): ActionDistribution;
}

export interface TokenUsage {
  total: number;
  prompt: number;
  cacheHit: number;
  cacheMiss: number;
}

export interface DecisionRecord {
  decisionId: string;
  episodeId: string;
  envVersion: string;
  policyVersion: string;
  playerId: string;
  informationClass: InformationClass;
  viewCondition: PolicyView['condition'];
  inputView: PlayerView | OracleView;
  inputViewHash: string;
  legalActions: Action[];
  candidateEvidence: CandidateEvidence[];
  gateDecision?: {
    modelVersion: string;
    expectedRegret: number;
    highRegretProbability: number;
    threshold: number;
    triggered: boolean;
  };
  llm?: {
    slot: 'reranker' | 'opponent_model' | 'direct_policy';
    modelProfileId: string;
    promptProfileId: string;
    exactMessages: Array<{ role: string; content: string }>;
    rawResponse: unknown;
    parsedOutput?: unknown;
    samplingParams: Record<string, unknown>;
    latencyMs: number;
    tokenUsage: TokenUsage;
    error?: string;
  };
  baselineAction: Action;
  chosenAction: Action;
  fallbackUsed: boolean;
  fallbackReason?: string;
  observation: PublicView;
  reward: { pointsDelta: number; terminalUtility?: number };
  regretLabel?: RegretLabel;
}

export type PayableCounts = Record<PayableToken, number>;
