import type { KubeconfigContexts } from '@capi-navigator/shared';
import { parse, stringify } from 'yaml';

/** A kubeconfig problem the user can fix; the message never contains credentials. */
export class KubeconfigError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

interface RawNamed<T> {
  name?: unknown;
  cluster?: T;
  user?: T;
  context?: T;
}
type Raw = Record<string, unknown>;

/** Connection settings with embedded data only; the input for a normalized kubeconfig. */
export interface ConnectionTarget {
  server: string;
  caData?: string;
  tlsServerName?: string;
  skipTlsVerify?: boolean;
  token?: string;
  certData?: string;
  keyData?: string;
  username?: string;
  password?: string;
}

/** Fields that would run commands or read files inside the backend: rejected (FP-2 decision). */
const FORBIDDEN_USER_FIELDS: Record<string, string> = {
  exec: 'runs a command (exec plugin)',
  'auth-provider': 'uses an auth-provider plugin',
  tokenFile: 'reads the token from a file',
  'client-certificate': 'reads the client certificate from a file',
  'client-key': 'reads the client key from a file',
};
const FORBIDDEN_CLUSTER_FIELDS: Record<string, string> = {
  'certificate-authority': 'reads the CA certificate from a file',
};
const TOKEN_HINT =
  'Use a service account token instead: apply the CAPI Navigator access manifest on the cluster and choose "Token".';

function parseYaml(text: string): Raw {
  let doc: unknown;
  try {
    doc = parse(text, { maxAliasCount: 50 });
  } catch {
    throw new KubeconfigError('The kubeconfig is not valid YAML', 'Upload the file unchanged.');
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new KubeconfigError('The kubeconfig is not a YAML object');
  }
  return doc as Raw;
}

function list(doc: Raw, key: 'clusters' | 'users' | 'contexts'): RawNamed<Raw>[] {
  const value = doc[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new KubeconfigError(`"${key}" must be a list`);
  return value as RawNamed<Raw>[];
}

function find<T>(items: RawNamed<T>[], name: string, what: string): T {
  const item = items.find((i) => i.name === name);
  const value = item?.[what as 'cluster' | 'user' | 'context'];
  if (!value || typeof value !== 'object') {
    throw new KubeconfigError(`The kubeconfig has no ${what} named "${name}"`);
  }
  return value;
}

function str(obj: Raw, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new KubeconfigError(`"${key}" must be a string`);
  return v;
}

/** Lists the contexts of a kubeconfig without returning any credentials. */
export function listContexts(text: string): KubeconfigContexts {
  const doc = parseYaml(text);
  const clusters = list(doc, 'clusters');
  const contexts = list(doc, 'contexts').map((c) => {
    const name = typeof c.name === 'string' ? c.name : '';
    const cluster = typeof c.context?.cluster === 'string' ? c.context.cluster : '';
    const clusterObj = clusters.find((cl) => cl.name === cluster)?.cluster;
    const server = typeof clusterObj?.server === 'string' ? clusterObj.server : '';
    return { name, cluster, server };
  });
  if (contexts.length === 0) throw new KubeconfigError('The kubeconfig contains no contexts');
  const current = typeof doc['current-context'] === 'string' ? doc['current-context'] : undefined;
  return { ...(current ? { currentContext: current } : {}), contexts };
}

/**
 * Extracts the connection settings of one context. Rejects everything that would execute
 * commands or read local files in the backend; only embedded data is accepted.
 */
export function extractTarget(
  text: string,
  contextName?: string,
): ConnectionTarget & { context: string } {
  const doc = parseYaml(text);
  const name =
    contextName ??
    (typeof doc['current-context'] === 'string' ? doc['current-context'] : undefined);
  if (!name) {
    throw new KubeconfigError(
      'The kubeconfig has no current-context',
      'Select the context to use.',
    );
  }
  const ctx = find(list(doc, 'contexts'), name, 'context');
  const clusterName = str(ctx, 'cluster');
  const userName = str(ctx, 'user');
  if (!clusterName || !userName) {
    throw new KubeconfigError(`Context "${name}" must reference a cluster and a user`);
  }
  const cluster = find(list(doc, 'clusters'), clusterName, 'cluster');
  const user = find(list(doc, 'users'), userName, 'user');

  for (const [field, why] of Object.entries(FORBIDDEN_USER_FIELDS)) {
    if (user[field] !== undefined) {
      throw new KubeconfigError(
        `The user "${userName}" ${why}, which CAPI Navigator does not allow for security reasons`,
        TOKEN_HINT,
      );
    }
  }
  for (const [field, why] of Object.entries(FORBIDDEN_CLUSTER_FIELDS)) {
    if (cluster[field] !== undefined) {
      throw new KubeconfigError(
        `The cluster "${clusterName}" ${why}; only embedded data is supported`,
        'Use certificate-authority-data instead (kubectl config view --raw --flatten).',
      );
    }
  }

  const server = str(cluster, 'server');
  if (!server || !/^https?:\/\//.test(server)) {
    throw new KubeconfigError(`The cluster "${clusterName}" has no valid server URL`);
  }
  const target: ConnectionTarget & { context: string } = {
    context: name,
    server,
    caData: str(cluster, 'certificate-authority-data'),
    tlsServerName: str(cluster, 'tls-server-name'),
    skipTlsVerify: cluster['insecure-skip-tls-verify'] === true,
    token: str(user, 'token'),
    certData: str(user, 'client-certificate-data'),
    keyData: str(user, 'client-key-data'),
    username: str(user, 'username'),
    password: str(user, 'password'),
  };
  if (!target.token && !(target.certData && target.keyData) && !target.username) {
    throw new KubeconfigError(
      `The user "${userName}" has no supported credentials`,
      'Supported: token, client-certificate-data + client-key-data, or basic auth.',
    );
  }
  return target;
}

/**
 * Builds a minimal kubeconfig with exactly one context from validated settings. This is what is
 * stored in the connection Secret, so the original file's other contexts never get stored.
 */
export function normalizedKubeconfig(name: string, t: ConnectionTarget): string {
  const cluster: Raw = { server: t.server };
  if (t.caData) cluster['certificate-authority-data'] = t.caData;
  if (t.tlsServerName) cluster['tls-server-name'] = t.tlsServerName;
  if (t.skipTlsVerify) cluster['insecure-skip-tls-verify'] = true;
  const user: Raw = {};
  if (t.token) user.token = t.token;
  if (t.certData) user['client-certificate-data'] = t.certData;
  if (t.keyData) user['client-key-data'] = t.keyData;
  if (t.username) user.username = t.username;
  if (t.password) user.password = t.password;
  return stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name, cluster }],
    users: [{ name, user }],
    contexts: [{ name, context: { cluster: name, user: name } }],
    'current-context': name,
  });
}

/** Turns a PEM certificate into kubeconfig `*-data` form (base64 of the PEM). */
export function pemToData(pem: string): string {
  return Buffer.from(pem.trim() + '\n', 'utf8').toString('base64');
}
