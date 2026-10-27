import { z } from 'zod';
import {
  AuthTypeSchema,
  ManagementClusterStatusSchema,
  OutboundProxySchema,
} from '../connections.js';
import type { CrdDefinition } from './types.js';

/**
 * `ManagementCluster` (FP2-F-02). Credentials are not part of the resource; they live in the
 * Secret named by {@link connectionSecretName} as a normalized single-context kubeconfig.
 */
export const ManagementClusterSpecSchema = z.object({
  displayName: z.string().optional(),
  authType: AuthTypeSchema,
  /** API server URL, for display. */
  server: z.string().optional(),
  /** Selected kubeconfig context, for display. */
  context: z.string().optional(),
  /** Incremented on every credential change; lets all replicas rebuild cached clients. */
  credentialsRevision: z.int().min(0).default(0),
  /**
   * Helm repository of the app that serves the chart of the manifest add-ons, e.g. a mirror
   * (FP30-F-02); default: the chart published on ghcr.io.
   */
  manifestChartRepository: z.string().optional(),
  /** Outbound proxy for provider controllers (FP-29); nothing secret in it. */
  outboundProxy: OutboundProxySchema.optional(),
});
export type ManagementClusterSpec = z.infer<typeof ManagementClusterSpecSchema>;

export const ManagementClusterCrd: CrdDefinition<
  typeof ManagementClusterSpecSchema,
  typeof ManagementClusterStatusSchema
> = {
  kind: 'ManagementCluster',
  plural: 'managementclusters',
  singular: 'managementcluster',
  shortNames: ['mgmt'],
  scope: 'Namespaced',
  spec: ManagementClusterSpecSchema,
  status: ManagementClusterStatusSchema,
  printerColumns: [
    { name: 'Auth', type: 'string', jsonPath: '.spec.authType' },
    { name: 'Server', type: 'string', jsonPath: '.spec.server' },
    { name: 'Phase', type: 'string', jsonPath: '.status.phase' },
    { name: 'Version', type: 'string', jsonPath: '.status.kubernetesVersion' },
    { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
  ],
};

/** Name of the Secret holding the credentials of a connection. */
export function connectionSecretName(name: string): string {
  return `management-cluster-${name}-credentials`;
}
