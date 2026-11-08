import {
  ClusterSpecSchema,
  distributionCatalog,
  FLAVOR_PLUGINS,
  INFRA_PLUGINS,
} from '@capi-navigator/shared';
import { PLATFORMS, type MatrixConfig, type Platform, type PlatformConfig } from './config.js';

export const FLAVORS = ['rke2', 'k0s', 'kubeadm'] as const;
export type Flavor = (typeof FLAVORS)[number];
export const MODES = ['aio', 'std', 'hcp'] as const;
export type Mode = (typeof MODES)[number];

const PLATFORM_KEY: Record<Platform, string> = {
  aws: 'aw',
  gcp: 'gc',
  openstack: 'os',
  proxmox: 'px',
};
const FLAVOR_KEY: Record<Flavor, string> = { rke2: 'r', k0s: 'k', kubeadm: 'a' };

/** One cell of the matrix. A hosted control plane case is a pair: host (k0s) and tenant. */
export interface Case {
  id: string;
  platform: Platform;
  flavor: Flavor;
  mode: Mode;
  airGapped: boolean;
}

/** The request body of POST /clusters and /clusters/preview. */
export interface CreateBody {
  grantCredentialNamespace: boolean;
  spec: Record<string, unknown> & { name: string; namespace: string };
}

export function caseId(prefix: string, c: Omit<Case, 'id'>): string {
  const what = c.mode === 'hcp' ? 'hcp' : `${FLAVOR_KEY[c.flavor]}-${c.mode}`;
  return `${prefix}-${PLATFORM_KEY[c.platform]}-${what}${c.airGapped ? '-ag' : ''}`;
}

/** Every case the configuration allows: AIO and 1+1 per distribution, HCP where supported. */
export function allCases(config: MatrixConfig): Case[] {
  const cases: Case[] = [];
  for (const platform of PLATFORMS) {
    const p = config.platforms[platform];
    if (!p) continue;
    for (const airGapped of [false, true]) {
      if (airGapped && !p.airGapped) continue;
      for (const flavor of FLAVORS) {
        if (airGapped && !FLAVOR_PLUGINS[flavor]?.airGap) continue;
        for (const mode of ['aio', 'std'] as const) {
          const c = { platform, flavor, mode, airGapped };
          cases.push({ id: caseId(config.prefix, c), ...c });
        }
      }
      if (INFRA_PLUGINS[platform].hosted && p.hcp) {
        const c = { platform, flavor: 'k0s' as const, mode: 'hcp' as const, airGapped };
        cases.push({ id: caseId(config.prefix, c), ...c });
      }
    }
  }
  return cases;
}

export interface Selection {
  platforms?: Platform[];
  flavors?: Flavor[];
  modes?: Mode[];
  /** online, airgap or both (default). */
  network?: 'online' | 'airgap' | 'all';
  /** Exact case IDs; overrides nothing else, narrows further. */
  ids?: string[];
}

export function selectCases(cases: Case[], s: Selection): Case[] {
  return cases.filter(
    (c) =>
      (!s.platforms?.length || s.platforms.includes(c.platform)) &&
      (!s.flavors?.length || s.flavors.includes(c.flavor)) &&
      (!s.modes?.length || s.modes.includes(c.mode)) &&
      (!s.network || s.network === 'all' || (s.network === 'airgap') === c.airGapped) &&
      (!s.ids?.length || s.ids.includes(c.id)),
  );
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge of patches; arrays and scalars replace. */
export function merge<T extends Record<string, unknown>>(base: T, ...patches: unknown[]): T {
  const out: Record<string, unknown> = { ...base };
  for (const patch of patches) {
    if (!isObject(patch)) continue;
    for (const [k, v] of Object.entries(patch)) {
      out[k] = isObject(v) && isObject(out[k]) ? merge(out[k] as Record<string, unknown>, v) : v;
    }
  }
  return out as T;
}

export function defaultVersion(flavor: Flavor): string {
  const versions = distributionCatalog(flavor)?.versions ?? [];
  const v = versions.find((x) => x.default) ?? versions[0];
  if (!v) throw new Error(`No ${flavor} version in the catalog`);
  return v.version;
}

interface BuildInput {
  config: MatrixConfig;
  /** The internal registry, resolved when the configuration says `connection`. */
  registry?: Record<string, unknown>;
  /** The slot patch the scheduler reserved for this case. */
  slot?: Record<string, unknown>;
}

function infrastructure(
  p: PlatformConfig,
  c: Case,
  flavor: Flavor,
  ...patches: unknown[]
): Record<string, unknown> {
  const image = (c.airGapped ? p.airGapped?.images[flavor] : undefined) ?? p.images[flavor];
  return merge(
    p.infrastructure,
    image ? { image } : {},
    c.airGapped ? p.airGapped?.infrastructure : {},
    ...patches,
  );
}

function body(
  config: MatrixConfig,
  name: string,
  flavor: Flavor,
  topology: Record<string, unknown>,
  infra: Record<string, unknown>,
  registry: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
): CreateBody {
  const spec = {
    name,
    namespace: config.app.namespace,
    kubernetes: { flavor, version: defaultVersion(flavor) },
    topology,
    infrastructure: infra,
    ...(registry ? { airGapped: { registry } } : {}),
    ...extra,
  };
  // Fails here, with the field, rather than as a 400 of the app.
  const parsed = ClusterSpecSchema.safeParse(spec);
  if (!parsed.success) {
    throw new Error(
      `${name}: invalid spec: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return { grantCredentialNamespace: config.app.grantCredentialNamespace, spec };
}

function registryFor(c: Case, input: BuildInput): Record<string, unknown> | undefined {
  if (!c.airGapped) return undefined;
  const r = input.config.platforms[c.platform]?.airGapped?.registry;
  const registry = r === 'connection' ? input.registry : r;
  if (!registry) throw new Error(`${c.id}: no internal registry (connection has none?)`);
  return registry;
}

/** The create requests of a case: one cluster, or host then tenant for hosted control planes. */
export function buildBodies(c: Case, input: BuildInput): CreateBody[] {
  const { config } = input;
  const p = config.platforms[c.platform];
  if (!p) throw new Error(`${c.id}: platform ${c.platform} not configured`);
  const registry = registryFor(c, input);
  const machine = (size: string) => ({ machineSize: size, ...p.machine });
  if (c.mode !== 'hcp') {
    const topology =
      c.mode === 'aio'
        ? {
            mode: 'all-in-one',
            controlPlane: { replicas: 1, ...machine(p.sizes.allInOne) },
            workerPools: [],
          }
        : {
            mode: 'standard',
            controlPlane: { replicas: 1, ...machine(p.sizes.controlPlane) },
            workerPools: [{ name: 'default', replicas: 1, ...machine(p.sizes.worker) }],
          };
    return [
      body(config, c.id, c.flavor, topology, infrastructure(p, c, c.flavor, input.slot), registry),
    ];
  }
  const hcp = (c.airGapped ? p.airGapped?.hcp : undefined) ?? p.hcp ?? { host: {}, tenant: {} };
  const host = `${c.id}-host`;
  return [
    body(
      config,
      host,
      'k0s',
      {
        mode: 'standard',
        controlPlane: { replicas: 1, ...machine(p.sizes.controlPlane) },
        workerPools: [
          { name: 'default', replicas: 1, ...machine(p.sizes.hostWorker ?? p.sizes.worker) },
        ],
      },
      infrastructure(p, c, 'k0s', hcp.host),
      registry,
      { controlPlaneHost: true },
    ),
    body(
      config,
      `${c.id}-ten`,
      'k0s',
      {
        mode: 'hosted',
        hosted: { host },
        controlPlane: { replicas: 1, machineSize: 'unused' },
        workerPools: [{ name: 'default', replicas: 1, ...machine(p.sizes.worker) }],
      },
      infrastructure(p, c, 'k0s', hcp.tenant),
      registry,
    ),
  ];
}
