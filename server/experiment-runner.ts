import { artifactIdentity } from '../src/decision/identity';
import type { ArtifactIdentity, EvidenceMode } from '../src/decision/types';
import { pairedEvaluate, type PairedEvaluationResult } from './paired-eval';
import type { PolicyRegistry } from './policy-registry';

export type ExperimentDesign = 'paired_comparison' | 'information_2x2' | 'direct_policy_ladder' | 'gate_efficiency';

export interface ExperimentArm {
  id: string;
  policyId: string;
  informationCondition?: 'partial' | 'full_experimental';
  inputPackage?: 'all_actions' | 'topk_with_evidence';
  gated?: boolean;
  gateArm?: 'baseline' | 'always_llm' | 'regret_gate' | 'stratified_random';
}

export interface ExperimentSpec {
  id: string;
  design: ExperimentDesign;
  anchorPolicyId: 'heuristic-honest';
  opponentPolicyId: string;
  evidenceMode: EvidenceMode;
  seeds: number[];
  arms: ExperimentArm[];
}

export interface ExperimentReport {
  artifact: ArtifactIdentity;
  experimentId: string;
  design: ExperimentDesign;
  anchorPolicyId: string;
  arms: Array<{ arm: ExperimentArm; result: PairedEvaluationResult }>;
}

export interface ExperimentJob {
  id: string;
  status: 'queued' | 'running' | 'complete' | 'failed';
  completedArms: number;
  totalArms: number;
  error?: string;
  report?: ExperimentReport;
}

export function validateExperimentSpec(spec: ExperimentSpec, registry: PolicyRegistry): void {
  if (!spec.id || spec.anchorPolicyId !== 'heuristic-honest') throw new Error('formal experiments must anchor to heuristic-honest');
  if (!spec.seeds.length || new Set(spec.seeds).size !== spec.seeds.length) throw new Error('experiment seeds must be a non-empty unique list');
  registry.resolve(spec.anchorPolicyId); registry.resolve(spec.opponentPolicyId);
  for (const arm of spec.arms) registry.resolve(arm.policyId);
  if (spec.design === 'paired_comparison') {
    if (!spec.arms.length) throw new Error('paired comparison requires at least one candidate arm');
  } else if (spec.design === 'information_2x2') {
    if (spec.arms.length !== 4 || spec.arms.some(arm => arm.gated !== false)) throw new Error('information 2x2 requires four ungated arms');
    const cells = new Set(spec.arms.map(arm => `${arm.informationCondition}:${arm.inputPackage}`));
    if (cells.size !== 4) throw new Error('information 2x2 must cover every information/input-package cell once');
  } else if (spec.design === 'direct_policy_ladder') {
    if (spec.arms.length !== 4) throw new Error('direct policy ladder requires four ordered arms');
  } else {
    const required = new Set(['baseline', 'always_llm', 'regret_gate', 'stratified_random']);
    if (spec.arms.length !== 4 || spec.arms.some(arm => !arm.gateArm || !required.delete(arm.gateArm))) throw new Error('gate efficiency requires the exact four arms');
  }
}

export class ExperimentRunner {
  private readonly jobs = new Map<string, ExperimentJob>();
  constructor(private readonly registry: PolicyRegistry) {}
  create(spec: ExperimentSpec): ExperimentJob {
    validateExperimentSpec(spec, this.registry);
    if (this.jobs.has(spec.id)) throw new Error(`experiment already exists: ${spec.id}`);
    const job: ExperimentJob = { id: spec.id, status: 'queued', completedArms: 0, totalArms: spec.arms.length };
    this.jobs.set(spec.id, job);
    void this.execute(spec, job);
    return structuredClone(job);
  }
  get(id: string): ExperimentJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown experiment: ${id}`);
    return structuredClone(job);
  }
  list(): ExperimentJob[] { return [...this.jobs.values()].map(job => structuredClone(job)); }
  private async execute(spec: ExperimentSpec, job: ExperimentJob): Promise<void> {
    job.status = 'running';
    const arms: ExperimentReport['arms'] = [];
    try {
      for (const arm of spec.arms) {
        const result = await pairedEvaluate(arm.policyId, spec.anchorPolicyId, spec.opponentPolicyId, this.registry, spec.seeds);
        arms.push({ arm, result }); job.completedArms++;
      }
      job.report = { artifact: artifactIdentity(spec, process.env.CODE_REVISION || 'development'), experimentId: spec.id, design: spec.design, anchorPolicyId: spec.anchorPolicyId, arms };
      job.status = 'complete';
    } catch (error) { job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error); }
  }
}
