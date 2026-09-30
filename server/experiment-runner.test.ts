import { describe, expect, it } from 'vitest';
import { defaultPolicyRegistry } from './paired-eval';
import { validateExperimentSpec, type ExperimentSpec } from './experiment-runner';

describe('configuration-driven experiment runner', () => {
  it('enforces an ungated complete information 2x2 and honest anchor', () => {
    const spec: ExperimentSpec = {
      id: '2x2', design: 'information_2x2', anchorPolicyId: 'heuristic-honest', opponentPolicyId: 'heuristic-honest', evidenceMode: 'marginalized', seeds: [1],
      arms: [
        ['partial', 'all_actions'], ['partial', 'topk_with_evidence'], ['full_experimental', 'all_actions'], ['full_experimental', 'topk_with_evidence'],
      ].map(([informationCondition, inputPackage], index) => ({ id: `a${index}`, policyId: 'heuristic-honest', informationCondition: informationCondition as 'partial' | 'full_experimental', inputPackage: inputPackage as 'all_actions' | 'topk_with_evidence', gated: false })),
    };
    expect(() => validateExperimentSpec(spec, defaultPolicyRegistry())).not.toThrow();
    spec.arms[0].gated = true;
    expect(() => validateExperimentSpec(spec, defaultPolicyRegistry())).toThrow(/ungated/);
  });
});

