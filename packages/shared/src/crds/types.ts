import type { z } from 'zod';

/** API group and version of the app's own CRDs (section 4, State storage). */
export const NAVIGATOR_GROUP = 'navigator.capi-navigator.io';
export const NAVIGATOR_VERSION = 'v1alpha1';
export const NAVIGATOR_API_VERSION = `${NAVIGATOR_GROUP}/${NAVIGATOR_VERSION}`;

export interface PrinterColumn {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'date';
  jsonPath: string;
}

/** Everything needed to generate a CRD and to access its objects (STATE-02). */
export interface CrdDefinition<
  TSpec extends z.ZodType = z.ZodType,
  TStatus extends z.ZodType = z.ZodType,
> {
  kind: string;
  plural: string;
  singular: string;
  shortNames?: string[];
  scope: 'Namespaced' | 'Cluster';
  spec: TSpec;
  /** Optional status schema; enables the status subresource. */
  status?: TStatus;
  printerColumns?: PrinterColumn[];
}

/** A typed custom resource of the app. */
export interface NavigatorResource<TSpec, TStatus = unknown> {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
    resourceVersion?: string;
    uid?: string;
    generation?: number;
  };
  spec: TSpec;
  status?: TStatus;
}
