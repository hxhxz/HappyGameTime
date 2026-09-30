import type { DecisionPolicy, PolicyContext, PolicyDecision } from './policy-registry';

export class PomcpDecisionPolicy implements DecisionPolicy {
  constructor(
    readonly id: string,
    readonly version: string,
    private readonly simulations: number,
    private readonly ownTurns: number,
  ) {}

  async decide(context: PolicyContext): Promise<PolicyDecision> {
    if (!context.search) throw new Error('POMCP policy requires an environment-owned search service');
    const result = context.search({ simulations: this.simulations, ownTurns: this.ownTurns });
    const index = context.rankedCandidates.findIndex(candidate => JSON.stringify(candidate.action) === JSON.stringify(result.action));
    if (index < 0) throw new Error('POMCP returned an action outside the common candidate set');
    return {
      action: result.action, chosenIndex: index,
      explanation: `POMCP best-response reference: ${this.simulations} simulations`,
      cost: { latencyMs: result.elapsedMs, usage: { total: 0, prompt: 0, cacheHit: 0, cacheMiss: 0 } },
      trace: { policyId: this.id },
    };
  }
}

