import type {
  CredentialProvider,
  CredentialSummary,
  CredentialTestResult,
  LookupKind,
  LookupOption,
} from '@capi-navigator/shared';

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
  /** Builds the cluster-scoped identity that references the Secret (ADR-0002). */
  identity(
    name: string,
    secret: { name: string; namespace: string },
    allowedNamespaces: string[],
  ): Record<string, unknown>;
  /** Reads the allowed namespaces back from an identity object. */
  allowedNamespaces(identity: Record<string, unknown>): string[];
  /** Tests the credentials against the cloud (read-only). */
  test(data: Record<string, string>, summary: CredentialSummary): Promise<CredentialTestResult>;
  lookupKinds: readonly LookupKind[];
  /** Selection lists for the cluster wizard (read-only). */
  lookup(
    data: Record<string, string>,
    summary: CredentialSummary,
    kind: LookupKind,
    opts: { region?: string },
  ): Promise<LookupOption[]>;
}
