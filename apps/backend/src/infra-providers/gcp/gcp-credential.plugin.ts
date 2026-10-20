import {
  GCP_IMAGE_FAMILIES,
  GCP_REQUIRED_PERMISSIONS,
  GcpCredentialInputSchema,
  type CredentialSummary,
  type CredentialTestResult,
  type LookupKind,
  type LookupOption,
} from '@capi-navigator/shared';
import { CredentialInputError, type CredentialPlugin } from '../credential-plugin.js';
import {
  accessToken,
  api,
  GCP_ENDPOINTS,
  GcpApiError,
  parseServiceAccountKey,
  type GcpEndpoints,
  type GcpServiceAccountKey,
} from './gcp-client.js';

/** Key in the Secret that CAPG reads through `GCPCluster.spec.credentialsRef` (cloud/scope/credentials.go). */
export const GCP_SECRET_KEY = 'credentials';

type Item = { name: string; description?: string; status?: string };

/**
 * Google Cloud credentials (FP25-F-02..04): a service account key stored as Secret in the CAPG
 * namespace and referenced by every cluster with `credentialsRef`. CAPG has no identity resource,
 * so the app keeps the allowed namespaces itself. Only read-only API calls.
 */
export class GcpCredentialPlugin implements CredentialPlugin<unknown> {
  readonly provider = 'gcp' as const;
  readonly catalogId = 'gcp';
  readonly lookupKinds = ['regions', 'zones', 'machineTypes', 'images', 'networks'] as const;

  readonly clusterKind = {
    version: 'v1beta1',
    plural: 'gcpclusters',
    usesCredential: (
      cluster: Record<string, unknown>,
      credential: { secret: { name: string; namespace: string } },
    ) => {
      const ref = (cluster.spec as { credentialsRef?: { name?: string; namespace?: string } })
        ?.credentialsRef;
      return ref?.name === credential.secret.name && ref?.namespace === credential.secret.namespace;
    },
  };

  constructor(private readonly endpoints: GcpEndpoints = GCP_ENDPOINTS) {}

  normalize(input: unknown): { data: Record<string, string>; summary: CredentialSummary } {
    const parsed = GcpCredentialInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new CredentialInputError(issue.message, undefined, `gcp.${issue.path.join('.')}`);
    }
    const key = parseServiceAccountKey(parsed.data.serviceAccountKey);
    return {
      // Stored as uploaded; CAPG detects the credential type from the JSON.
      data: { [GCP_SECRET_KEY]: parsed.data.serviceAccountKey },
      summary: {
        region: parsed.data.region,
        projectId: key.project_id,
        serviceAccount: key.client_email,
      },
    };
  }

  /** FP25-F-03: token, project, Compute Engine API, region and the permissions CAPG needs. */
  async test(
    data: Record<string, string>,
    summary: CredentialSummary,
  ): Promise<CredentialTestResult> {
    const testedAt = new Date().toISOString();
    let key: GcpServiceAccountKey;
    let token: string;
    try {
      key = parseServiceAccountKey(data[GCP_SECRET_KEY] ?? '');
      token = await accessToken(key);
    } catch (err) {
      return {
        ok: false,
        testedAt,
        checks: [{ name: 'Authentication (service account key)', ok: false }],
        ...explain(err),
      };
    }
    const project = key.project_id;
    const identity = `Project ${project} (${key.client_email})`;
    const checks: CredentialTestResult['checks'] = [
      { name: 'Authentication (service account key)', ok: true },
    ];
    const compute = `${this.endpoints.compute}/projects/${encodeURIComponent(project)}`;
    try {
      await api(token, compute);
      checks.push({ name: 'Compute Engine API', ok: true });
    } catch (err) {
      checks.push({
        name: 'Compute Engine API',
        ok: false,
        message: explain(err, project).message,
      });
      return { ok: false, testedAt, identity, checks, ...explain(err, project) };
    }
    const region = summary.region ?? '';
    try {
      await api(token, `${compute}/regions/${encodeURIComponent(region)}`);
      checks.push({ name: `Region ${region}`, ok: true });
    } catch (err) {
      checks.push({ name: `Region ${region}`, ok: false, message: explain(err, project).message });
    }
    let missing: string[] = [];
    try {
      const res = await api<{ permissions?: string[] }>(
        token,
        `${this.endpoints.resourceManager}/projects/${encodeURIComponent(project)}:testIamPermissions`,
        { permissions: [...GCP_REQUIRED_PERMISSIONS] },
      );
      const granted = new Set(res.permissions ?? []);
      missing = GCP_REQUIRED_PERMISSIONS.filter((p) => !granted.has(p));
      checks.push({
        name: 'Permissions for Cluster API',
        ok: missing.length === 0,
        ...(missing.length ? { message: `Missing: ${missing.join(', ')}` } : {}),
      });
    } catch (err) {
      // Without the Resource Manager API the permissions cannot be checked; CAPG may still work.
      checks.push({
        name: 'Permissions for Cluster API',
        ok: false,
        warning: true,
        message: `${explain(err, project).message}; permissions not checked (optional)`,
      });
    }
    const failed = checks.filter((c) => !c.ok && !c.warning);
    return {
      ok: failed.length === 0,
      testedAt,
      identity,
      checks,
      ...(missing.length
        ? {
            message: `The service account lacks ${missing.length} permission(s) that Cluster API needs`,
            hint: `Grant the service account the role "Editor" on project ${project} (IAM & Admin → IAM), or a custom role with these permissions.`,
          }
        : failed.length > 0
          ? { message: `${failed.length} check(s) failed` }
          : {}),
    };
  }

  /** Image references are self links ("projects/…/global/images/<name>"): the name is in it. */
  async imageNames(
    _data: Record<string, string>,
    _summary: CredentialSummary,
    ids: string[],
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const id of ids) {
      const name = /\/images\/([^/]+)$/.exec(id)?.[1];
      if (name) out[id] = name;
    }
    return out;
  }

  /** FP25-F-04: selection lists for the cluster wizard. Read-only. */
  async lookup(
    data: Record<string, string>,
    summary: CredentialSummary,
    kind: LookupKind,
    opts: { region?: string },
  ): Promise<LookupOption[]> {
    const key = parseServiceAccountKey(data[GCP_SECRET_KEY] ?? '');
    const token = await accessToken(key).catch((err: unknown) => fail(err, key.project_id));
    const project = `${this.endpoints.compute}/projects/${encodeURIComponent(key.project_id)}`;
    const region = opts.region ?? summary.region ?? '';
    const get = <T>(url: string) =>
      api<T>(token, url).catch((err: unknown) => fail(err, key.project_id));
    switch (kind) {
      case 'regions': {
        const res = await get<{ items?: Item[] }>(`${project}/regions`);
        return (res.items ?? [])
          .filter((r) => r.status !== 'DOWN')
          .map((r) => ({
            value: r.name,
            label: r.name,
            ...(r.description ? { details: { location: r.description } } : {}),
          }))
          .sort((a, b) => a.value.localeCompare(b.value));
      }
      case 'zones':
        return (await this.zones(get, project, region)).map((z) => ({ value: z, label: z }));
      case 'machineTypes': {
        const zone = (await this.zones(get, project, region))[0];
        if (!zone) return [];
        const res = await get<{
          items?: (Item & { guestCpus?: number; memoryMb?: number; deprecated?: unknown })[];
        }>(`${project}/zones/${encodeURIComponent(zone)}/machineTypes`);
        return (res.items ?? [])
          .filter(
            (m) =>
              !m.deprecated &&
              (m.guestCpus ?? 0) <= 32 &&
              /^(e2|n2|n2d|n4|c3|c4|t2d)-/.test(m.name),
          )
          .sort(
            (a, b) =>
              (a.guestCpus ?? 0) - (b.guestCpus ?? 0) || (a.memoryMb ?? 0) - (b.memoryMb ?? 0),
          )
          .map((m) => ({
            value: m.name,
            label: m.name,
            details: { vcpus: m.guestCpus ?? 0, ramGiB: Math.round((m.memoryMb ?? 0) / 1024) },
          }));
      }
      case 'images': {
        const out: LookupOption[] = [];
        for (const f of GCP_IMAGE_FAMILIES) {
          try {
            const image = await api<{ name: string; creationTimestamp?: string }>(
              token,
              `${this.endpoints.compute}/projects/${f.project}/global/images/family/${f.family}`,
            );
            out.push({
              value: `projects/${f.project}/global/images/${image.name}`,
              label: `${f.label} – ${image.name}`,
              details: {
                family: f.family,
                ...(image.creationTimestamp ? { created: image.creationTimestamp } : {}),
              },
            });
          } catch {
            // A family that is gone or not visible to the project is left out.
          }
        }
        return out;
      }
      case 'networks': {
        const res = await get<{ items?: Item[] }>(`${project}/global/networks`);
        return (res.items ?? []).map((n) => ({ value: n.name, label: n.name }));
      }
      default:
        return [];
    }
  }

  private async zones(
    get: <T>(url: string) => Promise<T>,
    project: string,
    region: string,
  ): Promise<string[]> {
    const res = await get<{ zones?: string[] }>(`${project}/regions/${encodeURIComponent(region)}`);
    return (res.zones ?? []).map((z) => z.split('/').pop()!).sort();
  }
}

function fail(err: unknown, project: string): never {
  const { message, hint } = explain(err, project);
  throw new CredentialInputError(message, hint);
}

const API_NAMES: Record<string, string> = {
  'compute.googleapis.com': 'Compute Engine API',
  'cloudresourcemanager.googleapis.com': 'Cloud Resource Manager API',
};

/** Understandable messages for Google API errors (no secrets). */
function explain(err: unknown, project?: string): { message: string; hint?: string } {
  if (err instanceof CredentialInputError) {
    return { message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
  }
  if (err instanceof GcpApiError) {
    if (err.reason === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(err.message)) {
      // Google names the disabled API in the error; Compute Engine is the one CAPG cannot do without.
      const service =
        err.service ??
        /([a-z]+\.googleapis\.com)/.exec(err.message)?.[1] ??
        'compute.googleapis.com';
      return {
        message: `The ${API_NAMES[service] ?? service} is not enabled in the project`,
        hint: `Enable it: https://console.cloud.google.com/apis/library/${service}?project=${project ?? ''}`,
      };
    }
    if (err.reason === 'invalid_grant') {
      return {
        message: 'Google refused the service account key',
        hint: 'The key may have been deleted or disabled; create a new key for the service account.',
      };
    }
    if (err.status === 403) {
      return {
        message: `No permission: ${err.message}`,
        hint: `Grant the service account the role "Editor" on project ${project ?? ''}.`,
      };
    }
    if (err.status === 404) return { message: `Not found: ${err.message}` };
    return { message: err.message };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}
