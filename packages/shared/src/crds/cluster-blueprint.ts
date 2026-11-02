import { ClusterBlueprintStorageSchema } from '../cluster/blueprint.js';
import type { CrdDefinition } from './types.js';

/** `ClusterBlueprint` (FP34-F-01, ADR-0035): a reviewed cluster spec with parameters. */
export const ClusterBlueprintCrd: CrdDefinition<typeof ClusterBlueprintStorageSchema> = {
  kind: 'ClusterBlueprint',
  plural: 'clusterblueprints',
  singular: 'clusterblueprint',
  shortNames: ['navblueprint'],
  scope: 'Namespaced',
  spec: ClusterBlueprintStorageSchema,
  printerColumns: [
    { name: 'Display name', type: 'string', jsonPath: '.spec.displayName' },
    { name: 'Connection', type: 'string', jsonPath: '.spec.connection' },
    { name: 'Namespace', type: 'string', jsonPath: '.spec.cluster.namespace' },
    { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
  ],
};
