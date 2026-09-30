import { DISABLED_REGRET_GATE, linearRegretGate, type LinearRegretGateModel } from '../src/decision/gate';
import type { RegretGate } from '../src/decision/types';
import type { Settings } from './agent';
import { NullLlmProvider, OpenAiCompatibleProvider, type LlmProvider } from './llm-provider';
import type { PersonaMode } from './strategy';

export type LlmInvocationMode = 'always' | 'regret_gated';
export type SeatConfig =
  | { kind: 'human'; name: string }
  | { kind: 'engine'; name: string; style: '抢分型' | '进化型' | '控场型'; personaMode: PersonaMode }
  | { kind: 'llm'; name: string; style: '抢分型' | '进化型' | '控场型'; personaMode: PersonaMode; modelProfileId: string; invocationMode: LlmInvocationMode };

export interface SessionConfig {
  mode: 'play' | 'experiment';
  seats: SeatConfig[];
  gateThreshold: number;
  evidenceMode: 'marginalized';
}

interface StoredModelProfile {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
}

export interface PublicModelProfile {
  id: string;
  label: string;
  model: string;
  configured: boolean;
}

function parseProfiles(): StoredModelProfile[] {
  const raw = process.env.MODEL_PROFILES_JSON;
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('MODEL_PROFILES_JSON must be valid JSON'); }
  if (!Array.isArray(value)) throw new Error('MODEL_PROFILES_JSON must be an array');
  return value.map((item, index) => {
    const profile = item as Partial<StoredModelProfile>;
    if (!profile.id || !profile.label || !profile.baseUrl || !profile.model || !profile.apiKeyEnv) throw new Error(`invalid model profile at index ${index}`);
    return profile as StoredModelProfile;
  });
}

const profiles = parseProfiles();

export function publicModelProfiles(): PublicModelProfile[] {
  return profiles.map(profile => ({ id: profile.id, label: profile.label, model: profile.model, configured: !!process.env[profile.apiKeyEnv] }));
}

export function modelSettings(profileId: string): Settings {
  const profile = profiles.find(item => item.id === profileId);
  if (!profile) throw new Error(`unknown model profile: ${profileId}`);
  const apiKey = process.env[profile.apiKeyEnv] ?? '';
  if (!apiKey) throw new Error(`model profile ${profile.label} has no configured secret`);
  return { baseUrl: profile.baseUrl, model: profile.model, apiKey };
}

export function llmProvider(profileId?: string): LlmProvider {
  if (!profileId) return new NullLlmProvider();
  const settings = modelSettings(profileId);
  return new OpenAiCompatibleProvider(`openai-compatible:${profileId}`, settings);
}

export function defaultSessionConfig(): SessionConfig {
  return {
    mode: 'play', gateThreshold: 0.5, evidenceMode: 'marginalized',
    seats: [
      { kind: 'human', name: '你' },
      { kind: 'engine', name: '赤焰', style: '抢分型', personaMode: 'neutral' },
      { kind: 'engine', name: '青岚', style: '进化型', personaMode: 'neutral' },
      { kind: 'engine', name: '紫苑', style: '控场型', personaMode: 'neutral' },
    ],
  };
}

export function validateSessionConfig(value: unknown): SessionConfig {
  const config = value as Partial<SessionConfig>;
  if (config.mode !== 'play' && config.mode !== 'experiment') throw new Error('invalid session mode');
  if (!Array.isArray(config.seats) || config.seats.length !== 4 || config.seats[0]?.kind !== 'human') throw new Error('exactly four seats are required and seat 0 must be human');
  for (const seat of config.seats) {
    if (!seat || !['human', 'engine', 'llm'].includes(seat.kind) || typeof seat.name !== 'string' || !seat.name.trim()) throw new Error('invalid seat config');
    if (seat.kind === 'llm') {
      if (!['always', 'regret_gated'].includes(seat.invocationMode)) throw new Error('invalid LLM invocation mode');
      modelSettings(seat.modelProfileId);
    }
    if (seat.kind !== 'human' && seat.personaMode !== undefined && !['neutral', 'scoring', 'evolution', 'control'].includes(seat.personaMode)) throw new Error('invalid persona mode');
  }
  const seats = config.seats.map(seat => seat.kind === 'human' ? seat : { ...seat, personaMode: seat.personaMode ?? 'neutral' }) as SeatConfig[];
  const gateThreshold = Number(config.gateThreshold ?? 0.5);
  if (!(gateThreshold >= 0 && gateThreshold <= 1)) throw new Error('gate threshold must be in [0,1]');
  return { mode: config.mode, seats, gateThreshold, evidenceMode: 'marginalized' };
}

export function configuredRegretGate(): RegretGate {
  const raw = process.env.REGRET_GATE_MODEL_JSON;
  if (!raw) return DISABLED_REGRET_GATE;
  let model: LinearRegretGateModel;
  try { model = JSON.parse(raw) as LinearRegretGateModel; } catch { throw new Error('REGRET_GATE_MODEL_JSON must be valid JSON'); }
  if (!model.version || !Number.isFinite(model.intercept) || !Number.isFinite(model.threshold) || !model.weights) throw new Error('invalid regret gate model');
  return linearRegretGate(model);
}
