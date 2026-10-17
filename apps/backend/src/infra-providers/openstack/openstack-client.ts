import { request } from 'node:https';
import { cloudAuthType, OpenStackCredentialError, type CloudEntry } from './clouds-yaml.js';

const TIMEOUT_MS = 15_000;
const MAX_BODY = 20 * 1024 * 1024;

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Minimal HTTPS JSON client; supports a custom CA (clouds.yaml `cacert`), unlike fetch. */
export type HttpFn = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; ca?: string },
) => Promise<HttpResponse>;

export const httpsRequest: HttpFn = (url, init) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...init.headers,
          // Some API gateways reject chunked request bodies.
          ...(init.body ? { 'Content-Length': String(Buffer.byteLength(init.body)) } : {}),
        },
        ...(init.ca ? { ca: init.ca } : {}),
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) req.destroy(new Error('Response too large'));
          else chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('timeout', () =>
      req.destroy(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' })),
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });

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

/** Versioned base URL of a service; catalogs may omit the version (e.g. Infomaniak). */
export function endpoint(session: OpenStackSession, type: string): string {
  const svc = session.catalog.find((s) => s.type === type);
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
