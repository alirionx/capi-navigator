import { httpsRequest, type HttpFn, type HttpResponse } from '../https-client.js';
import { cloudAuthType, OpenStackCredentialError, type CloudEntry } from './clouds-yaml.js';

export { httpsRequest, type HttpFn, type HttpResponse } from '../https-client.js';

interface CatalogEntry {
  type: string;
  endpoints: { interface: string; region_id?: string; region?: string; url: string }[];
}

export interface OpenStackSession {
  token: string;
  project?: { id: string; name: string; domain?: { name?: string } };
  user?: { name?: string };
  catalog: CatalogEntry[];
  region?: string;
  interface: string;
}

/** Errors from the cloud, translated into understandable messages (NF-06). */
function httpError(context: string, res: HttpResponse): OpenStackCredentialError {
  let detail: string;
  try {
    const body = JSON.parse(res.body) as Record<string, { message?: string } | undefined>;
    detail = Object.values(body).find((v) => v?.message)?.message ?? '';
  } catch {
    detail = res.body.slice(0, 200);
  }
  if (res.status === 401) {
    return new OpenStackCredentialError(
      `${context}: the cloud rejected the credentials`,
      'Check the application credential ID and secret; it may be expired or deleted.',
    );
  }
  if (res.status === 403) {
    return new OpenStackCredentialError(
      `${context}: permission denied`,
      'The application credential may be restricted (access rules) or lack the member role.',
    );
  }
  return new OpenStackCredentialError(`${context}: HTTP ${res.status} ${detail}`.trim());
}

function networkError(context: string, err: unknown): OpenStackCredentialError {
  const code = (err as { code?: string }).code ?? '';
  if (code === 'ENOTFOUND') {
    return new OpenStackCredentialError(`${context}: host not found`, 'Check the auth URL.');
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
    return new OpenStackCredentialError(
      `${context}: the server certificate is not trusted`,
      'Add the CA certificate of the cloud (cacert).',
    );
  }
  return new OpenStackCredentialError(
    `${context}: the cloud is not reachable (${code || (err instanceof Error ? err.message : 'error')})`,
    'Check network access from CAPI Navigator to the OpenStack APIs.',
  );
}

/** Keystone v3 authentication with application credential or password (FP4-F-04). */
export async function authenticate(
  cloud: CloudEntry,
  opts: { ca?: string; http?: HttpFn } = {},
): Promise<OpenStackSession> {
  const http = opts.http ?? httpsRequest;
  const a = cloud.auth;
  const type = cloudAuthType(cloud);
  const identity =
    type === 'v3applicationcredential'
      ? {
          methods: ['application_credential'],
          application_credential: {
            id: a.application_credential_id,
            secret: a.application_credential_secret,
          },
        }
      : {
          methods: ['password'],
          password: {
            user: {
              name: a.username,
              password: a.password,
              domain: { name: a.user_domain_name ?? a.domain_name ?? 'Default' },
            },
          },
        };
  const body: Record<string, unknown> = { auth: { identity } };
  if (type !== 'v3applicationcredential' && (a.project_name || a.project_id)) {
    body.auth = {
      identity,
      scope: {
        project: a.project_id
          ? { id: a.project_id }
          : {
              name: a.project_name,
              domain: { name: a.project_domain_name ?? a.domain_name ?? 'Default' },
            },
      },
    };
  }
  const authUrl = a.auth_url!.replace(/\/+$/, '').replace(/\/v3$/, '');
  let res: HttpResponse;
  try {
    res = await http(`${authUrl}/v3/auth/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(opts.ca ? { ca: opts.ca } : {}),
    });
  } catch (err) {
    throw networkError('Authentication', err);
  }
  if (res.status !== 201) throw httpError('Authentication', res);
  const token = res.headers['x-subject-token'];
  const parsed = JSON.parse(res.body) as { token: Omit<OpenStackSession, 'token' | 'interface'> };
  if (typeof token !== 'string') throw new OpenStackCredentialError('Keystone returned no token');
  return {
    token,
    catalog: parsed.token.catalog ?? [],
    ...(parsed.token.project ? { project: parsed.token.project } : {}),
    ...(parsed.token.user ? { user: parsed.token.user } : {}),
    ...(cloud.region_name ? { region: cloud.region_name } : {}),
    interface: cloud.interface ?? 'public',
  };
}

/**
 * Historical aliases of service types (OpenStack Service Types Authority): Kolla 2026.1 registers
 * Cinder as block-storage, older clouds as volumev3.
 */
const SERVICE_TYPE_ALIASES: Record<string, string[]> = {
  'block-storage': ['block-storage', 'volumev3', 'volume'],
};

/** Versioned base URL of a service; catalogs may omit the version (e.g. Infomaniak). */
export function endpoint(session: OpenStackSession, type: string): string {
  const types = SERVICE_TYPE_ALIASES[type] ?? [type];
  const svc = types
    .map((t) => session.catalog.find((s) => s.type === t))
    .find((s) => s !== undefined);
  const ep = svc?.endpoints.find(
    (e) =>
      e.interface === session.interface &&
      (!session.region || (e.region_id ?? e.region) === session.region),
  );
  if (!ep) {
    throw new OpenStackCredentialError(
      `The catalog has no ${type} endpoint in region ${session.region ?? '(any)'}`,
      'Check region_name in the clouds.yaml.',
    );
  }
  const url = ep.url.replace(/\/+$/, '');
  if (type === 'image' && !/\/v2$/.test(url)) return `${url}/v2`;
  if (type === 'network' && !/\/v2\.0$/.test(url)) return `${url}/v2.0`;
  return url;
}

/** GET a JSON resource of an OpenStack service. */
export async function getJson<T>(
  session: OpenStackSession,
  type: string,
  path: string,
  opts: { ca?: string; http?: HttpFn } = {},
): Promise<T> {
  const http = opts.http ?? httpsRequest;
  const url = `${endpoint(session, type)}${path}`;
  let res: HttpResponse;
  try {
    res = await http(url, {
      headers: { 'X-Auth-Token': session.token },
      ...(opts.ca ? { ca: opts.ca } : {}),
    });
  } catch (err) {
    throw networkError(`Read ${type}`, err);
  }
  if (res.status !== 200) throw httpError(`Read ${type}${path.split('?')[0]}`, res);
  return JSON.parse(res.body) as T;
}
