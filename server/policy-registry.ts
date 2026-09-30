import type { Action } from '../src/engine/types';
import type { Rng } from '../src/engine/rng';
import type { CandidateEvidence, PlayerView, TokenUsage } from '../src/decision/types';
import type { RegretGate } from '../src/decision/types';
import { cheapGateFeatures } from '../src/decision/gate';
import type { PersonaMode, RankedCandidate } from './strategy';
import type { Weights } from '../src/ai/heuristic';
import { messagesFor, parseDecision, type PromptSeat } from './agent';
import type { LlmProvider } from './llm-provider';

export interface PolicyContext {
  view: PlayerView;
  legalActions: Action[];
  candidates: CandidateEvidence[];
  rankedCandidates: RankedCandidate[];
  seat: PromptSeat;
  rng: Rng;
  search?: (request: { simulations: number; ownTurns: number }) => { action: Action; evidence: Map<string, import('../src/decision/types').SearchEvidence>; elapsedMs: number };
}

export interface PolicyDecision {
  action: Action;
  explanation?: string;
  chosenIndex: number;
  cost: { latencyMs: number; usage: TokenUsage };
  trace: { policyId: string; providerId?: string; exactMessages?: Array<{ role: string; content: string }>; responseText?: string; rawResponse?: unknown; parsedOutput?: unknown };
}

export interface DecisionPolicy {
  readonly id: string;
  readonly version: string;
  readonly candidateWeights?: Weights;
  decide(context: PolicyContext): Promise<PolicyDecision>;
}

export class PolicyRegistry {
  private readonly policies = new Map<string, DecisionPolicy>();
  register(policy: DecisionPolicy): void {
    if (this.policies.has(policy.id)) throw new Error(`duplicate policy id: ${policy.id}`);
    this.policies.set(policy.id, policy);
  }
  resolve(id: string): DecisionPolicy {
    const policy = this.policies.get(id);
    if (!policy) throw new Error(`unknown policy: ${id}`);
    return policy;
  }
  list(): Array<{ id: string; version: string }> { return [...this.policies.values()].map(policy => ({ id: policy.id, version: policy.version })); }
}

const zeroCost = { latencyMs: 0, usage: { total: 0, prompt: 0, cacheHit: 0, cacheMiss: 0 } };

export class CandidateTopPolicy implements DecisionPolicy {
  constructor(readonly id = 'heuristic-honest', readonly version = 'v2-neutral', readonly candidateWeights?: Weights) {}
  async decide(context: PolicyContext): Promise<PolicyDecision> {
    const first = context.rankedCandidates[0];
    if (!first) throw new Error('candidate policy received no candidates');
    return { action: first.action, chosenIndex: 0, cost: zeroCost, trace: { policyId: this.id } };
  }
}

export class LlmRerankPolicy implements DecisionPolicy {
  readonly version = 'v2';
  constructor(readonly id: string, private readonly provider: LlmProvider, private readonly model: string, private readonly personaMode?: PersonaMode) {}
  async decide(context: PolicyContext): Promise<PolicyDecision> {
    const seat = { ...context.seat, personaMode: this.personaMode ?? context.seat.personaMode };
    const messages = messagesFor(context.view, context.rankedCandidates, seat);
    const response = await this.provider.complete({ model: this.model, messages, sampling: {}, timeoutMs: 60_000 });
    const parsed = parseDecision(response.text, context.rankedCandidates.length, context.view.players.find(player => player.id === context.view.viewerId)?.points);
    return {
      action: context.rankedCandidates[parsed.actionId].action, chosenIndex: parsed.actionId, explanation: parsed.explanation,
      cost: { latencyMs: response.latencyMs, usage: response.usage },
      trace: { policyId: this.id, providerId: this.provider.id, exactMessages: messages, responseText: response.text, rawResponse: response.raw, parsedOutput: parsed },
    };
  }
}

export class RegretGatedPolicy implements DecisionPolicy {
  readonly version = 'v1';
  constructor(readonly id: string, private readonly baseline: DecisionPolicy, private readonly enhanced: DecisionPolicy, private readonly gate: RegretGate, private readonly threshold: number) {}
  async decide(context: PolicyContext): Promise<PolicyDecision> {
    const prediction = this.gate.predict(cheapGateFeatures(context.view, context.candidates));
    if (prediction.modelVersion === 'disabled-v1' || prediction.highRegretProbability < this.threshold) return this.baseline.decide(context);
    return this.enhanced.decide(context);
  }
}
