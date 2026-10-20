import { sign } from 'node:crypto';
import { CredentialInputError } from '../credential-plugin.js';

/** The fields of a service account key that the app uses (as downloaded from the console). */
export interface GcpServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  token_uri: string;
}

/** Google API base URLs; tests point them to a local fake. */
export interface GcpEndpoints {
  compute: string;
  resourceManager: string;
}

export const GCP_ENDPOINTS: GcpEndpoints = {
  compute: 'https://compute.googleapis.com/compute/v1',
  resourceManager: 'https://cloudresourcemanager.googleapis.com/v1',
};

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TIMEOUT_MS = 15_000;

/** An error answer of a Google API; message without secrets. */
export class GcpApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** e.g. SERVICE_DISABLED, PERMISSION_DENIED */
    readonly reason?: string,
    /** The API the error is about, e.g. cloudresourcemanager.googleapis.com (ErrorInfo metadata). */
    readonly service?: string,
  ) {
    super(message);
  }
}

/** Parses and checks a service account key (FP25-F-02); never echoes key material. */
export function parseServiceAccountKey(text: string): GcpServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CredentialInputError(
      'The key is not valid JSON',
      'Upload the JSON key file of the service account as downloaded from the Google Cloud console.',
      'gcp.serviceAccountKey',
    );
  }
  const key = parsed as Partial<GcpServiceAccountKey>;
  if (key.type !== 'service_account') {
    throw new CredentialInputError(
      'The JSON is not a service account key (type "service_account")',
      'Create a key for a service account under IAM & Admin → Service accounts → Keys.',
      'gcp.serviceAccountKey',
    );
  }
  for (const field of ['project_id', 'private_key', 'client_email', 'token_uri'] as const) {
    if (typeof key[field] !== 'string' || !key[field]) {
      throw new CredentialInputError(
        `The service account key has no "${field}"`,
        'Download a new JSON key; the file may be incomplete.',
        'gcp.serviceAccountKey',
      );
    }
  }
  return key as GcpServiceAccountKey;
}

/** Access token for the key: a signed JWT exchanged at the key's token URI (RFC 7523). */
export async function accessToken(key: GcpServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    ...(key.private_key_id ? { kid: key.private_key_id } : {}),
  };
  const claims = {
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri,
    iat: now,
    exp: now + 600,
  };
  const unsigned = `${b64(header)}.${b64(claims)}`;
  let signature: string;
  try {
    signature = sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url');
  } catch {
    throw new CredentialInputError(
      'The private key of the service account key cannot be read',
      'Download a new JSON key; the file may be damaged.',
      'gcp.serviceAccountKey',
    );
  }
  const res = await request(key.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }).toString(),
  });
  const token = (res as { access_token?: unknown }).access_token;
  if (typeof token !== 'string') throw new GcpApiError('No access token in the answer', 502);
  return token;
}

/** GET or POST a Google API with the access token; JSON in and out. */
export function api<T>(token: string, url: string, body?: unknown): Promise<T> {
  return request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as Promise<T>;
}

async function request(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new GcpApiError(
      `Google Cloud is not reachable (${new URL(url).host}): ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    const error = (json as { error?: unknown; error_description?: unknown }).error;
    // OAuth errors: { error: "invalid_grant", error_description }; API errors: { error: { … } }.
    if (typeof error === 'string') {
      const description = (json as { error_description?: string }).error_description;
      throw new GcpApiError(`${error}${description ? `: ${description}` : ''}`, res.status, error);
    }
    const e = error as
      | {
          message?: string;
          status?: string;
          details?: { reason?: string; metadata?: { service?: string } }[];
        }
      | undefined;
    const info = e?.details?.find((d) => d.reason);
    throw new GcpApiError(
      e?.message ?? `HTTP ${res.status}`,
      res.status,
      info?.reason ?? e?.status,
      info?.metadata?.service,
    );
  }
  return json;
}
