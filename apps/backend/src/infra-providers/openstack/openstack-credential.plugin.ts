import {
  LOOKUP_KINDS,
  OPENSTACK_IDENTITY,
  OpenStackCredentialInputSchema,
  type CredentialSummary,
  type CredentialTestResult,
  type LookupKind,
  type LookupOption,
  type OpenStackCredentialInput,
} from '@capi-navigator/shared';
import { CredentialInputError, type CredentialPlugin } from '../credential-plugin.js';
import {
  cloudAuthType,
  normalizeOpenStack,
  OpenStackCredentialError,
  readStoredCloud,
} from './clouds-yaml.js';
import {
  authenticate,
  endpoint,
  getJson,
  httpsRequest,
  type HttpFn,
  type OpenStackSession,
} from './openstack-client.js';

const NAME_LABEL = 'kubernetes.io/metadata.name';

/** OpenStack credentials for CAPO (FP4-F-01..06). */
export class OpenStackCredentialPlugin implements CredentialPlugin<OpenStackCredentialInput> {
  readonly provider = 'openstack' as const;
  readonly catalogId = 'openstack';
  readonly lookupKinds = LOOKUP_KINDS.openstack;

  constructor(private readonly http: HttpFn = httpsRequest) {}

  normalize(input: OpenStackCredentialInput) {
    try {
      const n = normalizeOpenStack(OpenStackCredentialInputSchema.parse(input));
      const summary: CredentialSummary = {
        cloudName: n.cloudName,
        authType: cloudAuthType(n.cloud),
        hasCaCert: !!n.cacert,
        ...(n.cloud.auth.auth_url ? { authUrl: n.cloud.auth.auth_url } : {}),
        ...(n.cloud.region_name ? { region: n.cloud.region_name } : {}),
        ...(n.cloud.auth.project_name ? { projectName: n.cloud.auth.project_name } : {}),
      };
      // Secret keys as CAPO expects them (FP4-F-03).
      const data: Record<string, string> = { 'clouds.yaml': n.cloudsYaml };
      if (n.cacert) data.cacert = n.cacert;
      return { data, summary };
    } catch (err) {
      if (err instanceof OpenStackCredentialError) {
        throw new CredentialInputError(err.message, err.hint, 'openstack');
      }
      throw err;
    }
  }

  identity(name: string, secret: { name: string; namespace: string }, namespaces: string[]) {
    return {
      apiVersion: OPENSTACK_IDENTITY.apiVersion,
      kind: OPENSTACK_IDENTITY.kind,
      metadata: { name },
      spec: {
        secretRef: secret,
        namespaceSelector: {
          matchExpressions: [{ key: NAME_LABEL, operator: 'In', values: [...namespaces].sort() }],
        },
      },
    };
  }

  allowedNamespaces(identity: Record<string, unknown>): string[] {
    const spec = identity.spec as
      | { namespaceSelector?: { matchExpressions?: { key: string; values?: string[] }[] } }
      | undefined;
    return (
      spec?.namespaceSelector?.matchExpressions?.find((e) => e.key === NAME_LABEL)?.values ?? []
    );
  }

  private async session(data: Record<string, string>): Promise<OpenStackSession> {
    const { cloud } = readStoredCloud(data['clouds.yaml'] ?? '');
    return authenticate(cloud, { http: this.http, ...(data.cacert ? { ca: data.cacert } : {}) });
  }

  /** FP4-F-04: obtain a token, read the project, check the services CAPO needs. */
  async test(data: Record<string, string>): Promise<CredentialTestResult> {
    const testedAt = new Date().toISOString();
    let session: OpenStackSession;
    try {
      session = await this.session(data);
    } catch (err) {
      return failed(testedAt, err, [{ name: 'Authentication', ok: false }]);
    }
    const checks: CredentialTestResult['checks'] = [{ name: 'Authentication', ok: true }];
    const services: [string, string][] = [
      ['compute', 'Compute (Nova)'],
      ['network', 'Network (Neutron)'],
      ['image', 'Image (Glance)'],
      ['load-balancer', 'Load balancer (Octavia)'],
      ['volumev3', 'Block storage (Cinder)'],
    ];
    for (const [type, label] of services) {
      try {
        endpoint(session, type);
        checks.push({ name: label, ok: true });
      } catch (err) {
        checks.push({ name: label, ok: false, message: (err as Error).message });
      }
    }
    try {
      await getJson(session, 'compute', '/flavors?limit=1', this.opts(data));
      checks.push({ name: 'Read flavors', ok: true });
    } catch (err) {
      checks.push({ name: 'Read flavors', ok: false, message: (err as Error).message });
    }
    const project = session.project;
    const identity = project
      ? `Project ${project.name}${project.domain?.name ? ` (domain ${project.domain.name})` : ''}`
      : undefined;
    const missing = checks.filter((c) => !c.ok);
    return {
      ok: missing.length === 0,
      testedAt,
      ...(identity ? { identity } : {}),
      checks,
      ...(missing.length > 0
        ? {
            message: `${missing.length} check(s) failed`,
            hint: 'The region may lack a service, or the credential may be restricted.',
          }
        : {}),
    };
  }

  /** FP4-F-05: selection lists for the cluster wizard. */
  async lookup(
    data: Record<string, string>,
    _s: CredentialSummary,
    kind: LookupKind,
  ): Promise<LookupOption[]> {
    const session = await this.session(data).catch((err: unknown) => {
      throw toInputError(err);
    });
    const opts = this.opts(data);
    try {
      switch (kind) {
        case 'images': {
          const images: GlanceImage[] = [];
          let next: string | undefined = '/images?status=active&limit=200&sort=name:asc';
          while (next && images.length < 2000) {
            const page: { images: GlanceImage[]; next?: string } = await getJson(
              session,
              'image',
              next.replace(/^\/v2/, ''),
              opts,
            );
            images.push(...page.images);
            next = page.next;
          }
          return images.map((i) => ({
            value: i.id,
            label: i.name ?? i.id,
            details: compact({
              os_distro: i.os_distro,
              os_version: i.os_version,
              visibility: i.visibility,
              created_at: i.created_at,
              min_disk: i.min_disk,
            }),
          }));
        }
        case 'flavors': {
          const { flavors } = await getJson<{ flavors: NovaFlavor[] }>(
            session,
            'compute',
            '/flavors/detail',
            opts,
          );
          return flavors
            .sort((a, b) => a.vcpus - b.vcpus || a.ram - b.ram || a.name.localeCompare(b.name))
            .map((f) => ({
              value: f.name,
              label: `${f.name} (${f.vcpus} vCPU, ${Math.round((f.ram / 1024) * 10) / 10} GiB RAM, ${f.disk} GB disk)`,
              details: { vcpus: f.vcpus, ramMiB: f.ram, diskGB: f.disk },
            }));
        }
        case 'externalNetworks': {
          const { networks } = await getJson<{ networks: { id: string; name: string }[] }>(
            session,
            'network',
            '/networks?router:external=true',
            opts,
          );
          return networks.map((n) => ({ value: n.id, label: n.name || n.id }));
        }
        case 'availabilityZones': {
          const res = await getJson<{
            availabilityZoneInfo: { zoneName: string; zoneState: { available: boolean } }[];
          }>(session, 'compute', '/os-availability-zone', opts);
          return res.availabilityZoneInfo
            .filter((z) => z.zoneState.available)
            .map((z) => ({ value: z.zoneName, label: z.zoneName }));
        }
        case 'keyPairs': {
          const res = await getJson<{ keypairs: { keypair: { name: string; type?: string } }[] }>(
            session,
            'compute',
            '/os-keypairs',
            opts,
          );
          return res.keypairs.map(({ keypair }) => ({ value: keypair.name, label: keypair.name }));
        }
        default:
          throw new CredentialInputError(`Unknown selection list "${kind}" for OpenStack`);
      }
    } catch (err) {
      throw toInputError(err);
    }
  }

  private opts(data: Record<string, string>) {
    return { http: this.http, ...(data.cacert ? { ca: data.cacert } : {}) };
  }
}

interface GlanceImage {
  id: string;
  name?: string;
  os_distro?: string;
  os_version?: string;
  visibility?: string;
  created_at?: string;
  min_disk?: number;
}

interface NovaFlavor {
  name: string;
  vcpus: number;
  ram: number;
  disk: number;
}

function compact(o: Record<string, string | number | undefined>): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== ''),
  ) as Record<string, string | number>;
}

function toInputError(err: unknown): unknown {
  return err instanceof OpenStackCredentialError
    ? new CredentialInputError(err.message, err.hint)
    : err;
}

function failed(
  testedAt: string,
  err: unknown,
  checks: CredentialTestResult['checks'],
): CredentialTestResult {
  if (err instanceof OpenStackCredentialError) {
    return {
      ok: false,
      testedAt,
      message: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
      checks,
    };
  }
  return {
    ok: false,
    testedAt,
    message: 'The credential test failed',
    details: err instanceof Error ? err.message : String(err),
    checks,
  };
}
