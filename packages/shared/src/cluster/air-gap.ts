import type { InternalRegistry } from '../connections.js';
import type { BootstrapFlavorPlugin, InfraTransformPlugin } from './plugins.js';
import type { ArtifactPin, ClusterSpec } from './spec.js';
import { FETCH_ARTIFACT_SCRIPT } from './templates/fetch-artifact.generated.js';

/**
 * FP-29 part B: nodes without internet install the distribution from OCI artifacts in the
 * internal registry and pull images through the container runtime's mirror configuration.
 * Pure helpers shared by the distributions; what differs per distribution is in their `airGap`.
 */

/** One file of a distribution's artifact: where it comes from upstream and where it goes. */
export interface AirGapFile {
  /** File name inside the artifact (the layer title of `oras push`). */
  name: string;
  /** Upstream download, for the push commands shown to admins (FP29-F-12). */
  url: string;
  /** Path on the node and its mode. */
  target: string;
  mode: string;
}

/** The binaries of one version of a distribution as OCI artifact (FP29-F-12). */
export interface AirGapArtifact {
  /** Repository name below the registry's artifacts path, e.g. rke2-artifacts. */
  name: string;
  /** Tag: the version with `+` as `-`, since tags must not contain `+`. */
  tag: string;
  files: AirGapFile[];
  /** Command checking the downloaded files upstream before the push, if the release has sums. */
  verify?: string;
}

export const artifactTag = (version: string) => version.replace(/\+/g, '-');

/** `<artifacts path>/<name>`: the artifact's repository in the internal registry. */
export const artifactRepository = (registry: InternalRegistry, artifact: AirGapArtifact) =>
  `${registry.artifactsPath}/${artifact.name}`;

const FETCH_SCRIPT_PATH = '/usr/local/bin/capi-navigator-fetch-artifact';
const REGISTRY_CA_PATH = '/etc/capi-navigator/registry-ca.crt';
/** Debian and Ubuntu read update-ca-certificates' directory; RHEL and derivatives the anchors. */
const TRUST_REGISTRY_CA = `if command -v update-ca-certificates >/dev/null; then install -m 0644 ${REGISTRY_CA_PATH} /usr/local/share/ca-certificates/capi-navigator-registry.crt && update-ca-certificates; else install -m 0644 ${REGISTRY_CA_PATH} /etc/pki/ca-trust/source/anchors/capi-navigator-registry.crt && update-ca-trust extract; fi`;

/** Node preparation of the infrastructure; without the parts that need the internet (FP29-F-15). */
export const nodePreparation = (spec: ClusterSpec, infra: InfraTransformPlugin) => [
  ...(infra.nodePreparation ?? []),
  ...(spec.airGapped ? [] : (infra.onlineNodePreparation ?? [])),
];

/** Public resolvers the wizards offer as default DNS servers. */
const PUBLIC_RESOLVERS = ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9'];

/**
 * Air-gapped nodes resolve the internal registry; public resolvers cannot reach or do not know it
 * (FP-29 live test: the download stopped and cloud-init failed). For infrastructures where the
 * nodes' DNS servers are set in the spec.
 */
export function airGapDnsWarnings(spec: ClusterSpec, dnsServers: string[]): string[] {
  const host = spec.airGapped?.registry.host.replace(/:\d+$/, '');
  const pub = dnsServers.filter((s) => PUBLIC_RESOLVERS.includes(s));
  if (!host || pub.length === 0) return [];
  return [
    `The nodes use the public DNS server(s) ${pub.join(', ')}, which air-gapped nodes cannot reach, and which do not know internal names: if ${host} is only in your internal DNS, the download of the binaries fails and the nodes never come up. Set your internal DNS servers in the Infrastructure step.`,
  ];
}

/** The pinned artifact of a version; the app resolves it before the transformation runs. */
export function artifactPin(spec: ClusterSpec, version: string): ArtifactPin {
  const pin = spec.airGapped?.artifacts.find((a) => a.version === version);
  if (!pin) throw new Error(`No artifact of ${version} is pinned for the air-gapped cluster`);
  return pin;
}

/**
 * FP29-F-13, FP29-F-14: files and commands every node of an air-gapped cluster runs before the
 * distribution is installed: the registry CA into the system trust store (containerd and the
 * download use it), then the download of the version's files by digest. A failed download ends
 * the commands (`exit 1`), so the distribution is not installed with missing or changed files.
 */
export function airGapNodeSetup(
  spec: ClusterSpec,
  flavor: BootstrapFlavorPlugin,
  version: string,
): { files: { path: string; content: string; permissions: string }[]; commands: string[] } {
  const airGapped = spec.airGapped;
  if (!airGapped || !flavor.airGap) return { files: [], commands: [] };
  const { registry } = airGapped;
  const ca = registry.caCert
    ? {
        files: [
          { path: REGISTRY_CA_PATH, content: `${registry.caCert.trim()}\n`, permissions: '0644' },
        ],
        commands: [TRUST_REGISTRY_CA],
      }
    : { files: [], commands: [] };
  // ADR-0032: distributions without an artifact (kubeadm) find their binaries in the image.
  if (!flavor.airGap.artifact) return ca;
  const artifact = flavor.airGap.artifact(version);
  const pin = artifactPin(spec, version);
  const targets = artifact.files.map((f) => {
    const digest = pin.files.find((p) => p.name === f.name)?.digest;
    if (!digest) throw new Error(`The pinned artifact of ${version} has no file ${f.name}`);
    return `${digest} ${f.target} ${f.mode}`;
  });
  return {
    files: [
      ...ca.files,
      { path: FETCH_SCRIPT_PATH, content: FETCH_ARTIFACT_SCRIPT, permissions: '0755' },
    ],
    commands: [
      ...ca.commands,
      `python3 ${FETCH_SCRIPT_PATH} https://${registry.host} ${pin.repository} ${targets.join(' ')} || exit 1`,
    ],
  };
}

/** Registry address of a mirror: host and, where images are below a path, that path. */
const mirrorPath = (m: InternalRegistry['mirrors'][number]) => (m.path ? `/${m.path}` : '');

/**
 * RKE2 `privateRegistriesConfig.mirrors` (FP29-F-14): every upstream registry through the
 * internal one; `rewrite` maps the repository below the mirror's path.
 */
export function rke2RegistryMirrors(registry: InternalRegistry): Record<string, unknown> {
  return Object.fromEntries(
    registry.mirrors.map((m) => [
      m.upstream,
      {
        endpoint: [`https://${registry.host}`],
        ...(m.path ? { rewrite: { '^(.*)$': `${m.path}/$1` } } : {}),
      },
    ]),
  );
}

/** containerd's name for Docker Hub's registry API (`server` of its hosts.toml). */
const upstreamServer = (upstream: string) =>
  upstream === 'docker.io' ? 'https://registry-1.docker.io' : `https://${upstream}`;

/**
 * containerd `hosts.toml` per upstream registry (FP29-F-14), for distributions that take a
 * `config_path` (k0s). It has no rewrite: the host URL carries the API path and the mirror's path,
 * and `override_path` makes containerd use it as is.
 */
export function containerdHostsFiles(
  registry: InternalRegistry,
  dir: string,
): { path: string; content: string; permissions: string }[] {
  return registry.mirrors.map((m) => ({
    path: `${dir}/${m.upstream}/hosts.toml`,
    content: [
      `server = "${upstreamServer(m.upstream)}"`,
      '',
      `[host."https://${registry.host}/v2${mirrorPath(m)}"]`,
      '  capabilities = ["pull", "resolve"]',
      '  override_path = true',
      '',
    ].join('\n'),
    permissions: '0644',
  }));
}

/**
 * FP29-F-12: commands an admin runs on a machine with internet access to put the artifact of a
 * version into the internal registry: download from the upstream release, check, `oras push`.
 * Files are pushed without a path, so each layer's digest is the sha256 of its file.
 */
export function artifactPushCommands(registry: InternalRegistry, artifact: AirGapArtifact): string {
  const dir = `${artifact.name}-${artifact.tag}`;
  return [
    `mkdir -p ${dir} && cd ${dir}`,
    ...artifact.files.map((f) => `curl -fL -o ${f.name} '${f.url}'`),
    ...(artifact.verify ? [artifact.verify] : []),
    `oras push ${registry.host}/${artifactRepository(registry, artifact)}:${artifact.tag} ${artifact.files.map((f) => f.name).join(' ')}`,
  ].join('\n');
}
