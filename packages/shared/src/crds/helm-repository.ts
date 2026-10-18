import { HelmRepositorySpecSchema } from '../helm/repository.js';
import type { CrdDefinition } from './types.js';

/** `HelmRepository` (FP8-F-02); credentials live in the Secret named by helmRepositorySecretName. */
export const HelmRepositoryCrd: CrdDefinition<typeof HelmRepositorySpecSchema> = {
  kind: 'HelmRepository',
  plural: 'helmrepositories',
  singular: 'helmrepository',
  shortNames: ['navhelmrepo'],
  scope: 'Namespaced',
  spec: HelmRepositorySpecSchema,
  printerColumns: [
    { name: 'Type', type: 'string', jsonPath: '.spec.type' },
    { name: 'URL', type: 'string', jsonPath: '.spec.url' },
    { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
  ],
};
