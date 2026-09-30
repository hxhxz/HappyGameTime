import type { EvidenceMode } from './types';

export type InformationCondition = 'partial' | 'full_experimental';
export type InputPackage = 'all_actions' | 'topk_with_evidence';

export interface InformationExperimentCell {
  informationCondition: InformationCondition;
  inputPackage: InputPackage;
  gated: false;
  evidenceMode: EvidenceMode;
}

export function informationExperiment2x2(mode: EvidenceMode = 'marginalized'): InformationExperimentCell[] {
  return (['partial', 'full_experimental'] as const).flatMap(informationCondition =>
    (['all_actions', 'topk_with_evidence'] as const).map(inputPackage => ({ informationCondition, inputPackage, gated: false as const, evidenceMode: mode })),
  );
}

export type DirectPolicyCondition =
  | 'partial_all_actions'
  | 'partial_topk'
  | 'partial_topk_with_honest_evidence'
  | 'oracle_all_actions';

export const DIRECT_POLICY_LADDER: readonly DirectPolicyCondition[] = [
  'partial_all_actions', 'partial_topk', 'partial_topk_with_honest_evidence', 'oracle_all_actions',
] as const;

export type GateEfficiencyArm = 'baseline' | 'always_llm' | 'regret_gate' | 'stratified_random';

export const GATE_EFFICIENCY_ARMS: readonly GateEfficiencyArm[] = ['baseline', 'always_llm', 'regret_gate', 'stratified_random'] as const;

