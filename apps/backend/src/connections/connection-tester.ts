import { AuthorizationV1Api, VersionApi, type KubeConfig } from '@kubernetes/client-node';
import {
  REQUIRED_PERMISSIONS,
  type ManagementClusterStatus,
  type PermissionCheck,
} from '@capi-navigator/shared';
import { kubeMessage, kubeStatus } from '../kube/errors.js';

const TIMEOUT_MS = 8000;

/**
 * Tests a connection: reachability, Kubernetes version and permissions via
 * SelfSubjectAccessReview (FP2-F-04). Problems are explained instead of shown raw (FP2-F-06).
 */
export async function testConnection(
  kc: KubeConfig,
  now: () => Date = () => new Date(),
): Promise<ManagementClusterStatus> {
  const checkedAt = now().toISOString();
  let version: string;
  try {
    const info = await withTimeout(kc.makeApiClient(VersionApi).getCode(), TIMEOUT_MS);
    version = info.gitVersion;
  } catch (err) {
    return { ...explainError(err), lastCheckedAt: checkedAt };
  }

  let permissions: PermissionCheck[];
  try {
    permissions = await checkPermissions(kc);
  } catch (err) {
    // /version is often readable anonymously; credentials are only verified here.
    return { ...explainError(err), kubernetesVersion: version, lastCheckedAt: checkedAt };
  }

  const missingRequired = permissions.filter((p) => !p.allowed && p.level === 'required');
  const missingInstall = permissions.filter((p) => !p.allowed && p.level === 'install');
  const status: ManagementClusterStatus = {
    phase: 'Reachable',
    kubernetesVersion: version,
    lastCheckedAt: checkedAt,
    permissions,
  };
  if (missingRequired.length > 0) {
    return {
      ...status,
      message: `Reachable, but ${missingRequired.length} required permission(s) are missing`,
      hint: 'Apply deploy/management-cluster/capi-navigator-access.yaml on the cluster and use its token, or grant the listed permissions.',
    };
  }
  if (missingInstall.length > 0) {
    return {
      ...status,
      message: 'Reachable; ORC and providers cannot be installed with these permissions',
      hint: 'Fine if cert-manager, the CAPI Operator and ORC are installed by other means (minimal role).',
    };
  }
  return status;
}

async function checkPermissions(kc: KubeConfig): Promise<PermissionCheck[]> {
  const api = kc.makeApiClient(AuthorizationV1Api);
  return Promise.all(
    REQUIRED_PERMISSIONS.map(async (p) => {
      const review = await withTimeout(
        api.createSelfSubjectAccessReview({
          body: {
            apiVersion: 'authorization.k8s.io/v1',
            kind: 'SelfSubjectAccessReview',
            spec: { resourceAttributes: { group: p.group, resource: p.resource, verb: p.verb } },
          },
        }),
        TIMEOUT_MS,
      );
      return { ...p, allowed: review.status?.allowed === true };
    }),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(Object.assign(new Error(`No answer within ${ms / 1000} s`), { code: 'TIMEOUT' })),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Error code of a network/TLS error, also when wrapped as `cause` by fetch. */
function errorCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

function errorText(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    if (e instanceof Error) parts.push(e.message);
    e = (e as { cause?: unknown }).cause;
  }
  return parts.join(': ') || String(err);
}

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_SIGNATURE_FAILURE',
]);

/** Understandable message + hint for a failed test (FP2-F-06). Never includes credentials. */
export function explainError(err: unknown): ManagementClusterStatus {
  const status = kubeStatus(err);
  const code = errorCode(err);
  const details = (
    status ? `HTTP ${status}: ${kubeMessage(err) ?? 'no message'}` : errorText(err)
  ).slice(0, 1000);
  const result = (
    phase: ManagementClusterStatus['phase'],
    message: string,
    hint: string,
  ): ManagementClusterStatus => ({ phase, message, hint, details });

  if (status === 401) {
    return result(
      'Unauthorized',
      'The cluster rejected the credentials',
      'The token is invalid or expired, or the client certificate is not accepted. Create a new token and update the connection.',
    );
  }
  if (status === 403) {
    return result(
      'Unauthorized',
      'The credentials are valid, but lack basic permissions',
      'Bind the service account to the CAPI Navigator ClusterRole (deploy/management-cluster).',
    );
  }
  if (code === 'ECONNREFUSED') {
    return result(
      'Unreachable',
      'Connection refused by the API server address',
      'Check the server URL and port. A kind cluster on 127.0.0.1 is only reachable from the same machine.',
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return result(
      'Unreachable',
      'The API server host name cannot be resolved',
      'Check the server URL and DNS.',
    );
  }
  if (
    code === 'TIMEOUT' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH'
  ) {
    return result(
      'Unreachable',
      'The API server does not answer',
      'Check firewalls and network routes between CAPI Navigator and the cluster.',
    );
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return result(
      'Unreachable',
      'The server certificate does not match the server address',
      'Use the host name the certificate was issued for, or set tls-server-name in the kubeconfig.',
    );
  }
  if (code === 'CERT_HAS_EXPIRED') {
    return result(
      'Unreachable',
      'The server certificate has expired',
      'Renew the API server certificate.',
    );
  }
  if (code && TLS_CODES.has(code)) {
    return result(
      'Unreachable',
      'The server certificate is not trusted',
      'Provide the CA certificate of the cluster (ca.crt of the service account token Secret).',
    );
  }
  return result(
    'Unreachable',
    'The cluster could not be reached',
    'Check the server URL and network access. The original error is shown below.',
  );
}
