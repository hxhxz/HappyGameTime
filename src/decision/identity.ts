import { ARTIFACT_SCHEMA_VERSION, ENV_VERSION, type ArtifactIdentity } from './types';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  return value;
}

export function stableHash(value: unknown): string {
  const text = JSON.stringify(stable(value));
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193);
    b = Math.imul(b ^ text.charCodeAt(i), 0x85ebca6b);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function artifactIdentity(config: unknown, codeRevision = 'development'): ArtifactIdentity {
  return { envVersion: ENV_VERSION, schemaVersion: ARTIFACT_SCHEMA_VERSION, codeRevision, configHash: stableHash(config) };
}

export function batchEpisodeId(input: { experimentId: string; seed: number; replicateIndex: number; seatRotation: number }): string {
  return `episode-${stableHash({ envVersion: ENV_VERSION, ...input })}`;
}

export function interactiveEpisodeId(randomId: string): string {
  if (!randomId) throw new Error('interactive episode id requires a server-generated random id');
  return `episode-${randomId}`;
}

