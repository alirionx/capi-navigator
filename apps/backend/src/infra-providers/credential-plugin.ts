import type { KubernetesObject } from '@kubernetes/client-node';
import type {
  ClusterSpec,
  CredentialProvider,
  CredentialSummary,
  CredentialTestResult,
  LookupKind,
  LookupOption,
} from '@capi-navigator/shared';

export interface IdentityResource {
  apiVersion: string;
  kind: string;
  group: string;
  version: string;
  plural: string;
}

/** A user-fixable credential problem; message and hint never contain secret values. */
export class CredentialInputError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/**
 * Credential part of an infrastructure provider plugin (section 5, `InfraProviderPlugin`:
 * credentialSchema and lookups). Generic modules only use this interface (hard rule 10).
 */
export interface CredentialPlugin<TInput = unknown> {
  provider: CredentialProvider;
  /** Catalog id of the infrastructure provider whose namespace holds the Secrets. */
  catalogId: string;
  /** Validates the input and returns the Secret data in the provider's format plus a summary. */
  normalize(input: TInput): { data: Record<string, string>; summary: CredentialSummary };
  /**
   * The provider's cluster-scoped identity that references the Secret and holds the allowed
   * namespaces (ADR-0002). Providers without one (CAPG references the Secret directly) leave it
   * out; the app then keeps the allowed namespaces on the Secret and enforces them itself.
   */
  identity?: {
    resource: IdentityResource;
    build(
      name: string,
      secret: { name: string; namespace: string },
      allowedNamespaces: string[],
    ): Record<string, unknown>;
    /** Reads the allowed namespaces back from an identity object. */
    allowedNamespaces(identity: Record<string, unknown>): string[];
  };
  /** The infrastructure cluster kind and how it references a credential (removal check). */
  clusterKind: {
    version: string;
    plural: string;
    usesCredential(
      cluster: Record<string, unknown>,
      credential: { name: string; secret: { name: string; namespace: string } },
    ): boolean;
  };
  /**
   * Secret key of a CA certificate the provider's controller must trust (FP31-F-01); the CAs of
   * all credentials of the provider form its CA bundle.
   */
  caDataKey?: string;
  /**
   * Secrets a cluster gets from the stored credential, in its namespace (FP31-F-09, F-11): `objects`
   * are applied, `preview` shows them with masked values.
   */
  clusterSecrets?(
    spec: ClusterSpec,
    credential: { name: string; data: Record<string, string> },
  ): { objects: KubernetesObject[]; preview: KubernetesObject[] };
  /** Tests the credentials against the cloud (read-only). */
  test(data: Record<string, string>, summary: CredentialSummary): Promise<CredentialTestResult>;
  lookupKinds: readonly LookupKind[];
  /**
   * Names of images by ID (read-only), for the cluster detail view. IDs the cloud does not know
   * are left out of the result.
   */
  imageNames(
    data: Record<string, string>,
    summary: CredentialSummary,
    ids: string[],
    opts: { region?: string },
  ): Promise<Record<string, string>>;
  /** Selection lists for the cluster wizard (read-only). */
  lookup(
    data: Record<string, string>,
    summary: CredentialSummary,
    kind: LookupKind,
    opts: { region?: string },
  ): Promise<LookupOption[]>;
}
