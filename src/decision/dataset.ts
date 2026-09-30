import type { DatasetManifest, InformationClass } from './types';

type TrainingPurpose = DatasetManifest['allowedPurposes'][number];

export function assertDatasetAllowed(manifest: DatasetManifest, purpose: TrainingPurpose): void {
  if (!manifest.allowedPurposes.includes(purpose)) throw new Error(`dataset does not allow purpose: ${purpose}`);
  if (manifest.informationClass === 'oracle_full' && purpose !== 'oracle_baseline') {
    throw new Error(`oracle_full dataset cannot train ${purpose}`);
  }
}

export function checkpointInformationClass(manifests: DatasetManifest[]): InformationClass {
  return manifests.some(manifest => manifest.informationClass === 'oracle_full') ? 'oracle_full' : 'honest_partial';
}

export function assertHonestCheckpoint(informationClass: InformationClass): void {
  if (informationClass !== 'honest_partial') throw new Error('oracle checkpoint cannot be registered as an honest policy');
}

