import { rootCertificates } from 'node:tls';
import type { KubernetesObject } from '@kubernetes/client-node';
import { stringify } from 'yaml';
import {
  DEFAULT_PROXMOX_MACHINE_SIZES,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  PROXMOX_CLOUD_CONFIG_SECRET,
  proxmoxCloudConfigName,
  proxmoxCredentialsCopyName,
  type ClusterSpec,
  PROXMOX_CREDENTIAL_ANNOTATION,
  PROXMOX_REQUIRED_PRIVILEGES,
  ProxmoxCredentialInputSchema,
  type CredentialSummary,
  type CredentialTestResult,
  type LookupKind,
  type LookupOption,
} from '@capi-navigator/shared';
import { httpsRequest, type HttpFn } from '../https-client.js';
import { CredentialInputError, type CredentialPlugin } from '../credential-plugin.js';

/** Keys of the Secret in the format CAPMOX reads through `ProxmoxCluster.spec.credentialsRef`. */
export const PROXMOX_SECRET_KEYS = { url: 'url', token: 'token', secret: 'secret', ca: 'ca.crt' };

/** A Proxmox API error with its HTTP status; the message never contains the token. */
export class ProxmoxApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

interface Resource {
  vmid: number;
  name?: string;
  node: string;
  template?: number;
}

/**
 * Proxmox VE credentials (FP31-F-02..05, ADR-0027): an API token stored as Secret in the CAPMOX
 * namespace. CAPMOX has no identity resource and takes ownership of the Secret a cluster
 * references, so clusters get a copy and are found by an annotation on the ProxmoxCluster. Only
 * read-only API calls; TLS is checked against the stored CA (or the system trust store).
 */
export class ProxmoxCredentialPlugin implements CredentialPlugin<unknown> {
  readonly provider = 'proxmox' as const;
  readonly catalogId = 'proxmox';
  readonly lookupKinds = ['nodes', 'templates', 'bridges', 'storages', 'machineSizes'] as const;
  readonly caDataKey = PROXMOX_SECRET_KEYS.ca;

  readonly clusterKind = {
    version: 'v1alpha2',
    plural: 'proxmoxclusters',
    usesCredential: (cluster: Record<string, unknown>, credential: { name: string }) =>
      (cluster.metadata as { annotations?: Record<string, string> } | undefined)?.annotations?.[
        PROXMOX_CREDENTIAL_ANNOTATION
      ] === credential.name,
  };

  constructor(private readonly http: HttpFn = httpsRequest) {}

  normalize(input: unknown): { data: Record<string, string>; summary: CredentialSummary } {
    const parsed = ProxmoxCredentialInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new CredentialInputError(issue.message, undefined, `proxmox.${issue.path.join('.')}`);
    }
    const p = parsed.data;
    const ca = p.caCert?.trim();
    return {
      data: {
        [PROXMOX_SECRET_KEYS.url]: p.url,
        [PROXMOX_SECRET_KEYS.token]: p.tokenId,
        [PROXMOX_SECRET_KEYS.secret]: p.tokenSecret,
        ...(ca ? { [PROXMOX_SECRET_KEYS.ca]: `${ca}\n` } : {}),
      },
      summary: {
        url: p.url,
        tokenId: p.tokenId,
        hasCaCert: !!ca,
        machineSizes: p.machineSizes ?? DEFAULT_PROXMOX_MACHINE_SIZES,
      },
    };
  }

  /**
   * FP31-F-09: the cluster's own copy of the token, which CAPMOX takes ownership of and deletes
   * with the cluster. FP31-F-11: the configuration of CCM and CSI, delivered into the workload
   * cluster by the ClusterResourceSet of the plugin (as ADR-0004).
   */
  clusterSecrets(spec: ClusterSpec, credential: { name: string; data: Record<string, string> }) {
    const d = credential.data;
    const labels = {
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      'cluster.x-k8s.io/cluster-name': spec.name,
    };
    const copy = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: proxmoxCredentialsCopyName(spec.name), namespace: spec.namespace, labels },
      type: 'Opaque',
      stringData: {
        url: d[PROXMOX_SECRET_KEYS.url] ?? '',
        token: d[PROXMOX_SECRET_KEYS.token] ?? '',
        secret: d[PROXMOX_SECRET_KEYS.secret] ?? '',
      },
    };
    const masked = (o: { stringData?: object; data?: object }) => ({
      ...o,
      ...(o.stringData
        ? { stringData: Object.fromEntries(Object.keys(o.stringData).map((k) => [k, '********'])) }
        : {}),
      ...(o.data
        ? { data: Object.fromEntries(Object.keys(o.data).map((k) => [k, '********'])) }
        : {}),
    });
    const objects: KubernetesObject[] = [copy];
    const preview: KubernetesObject[] = [masked(copy) as KubernetesObject];
    if (spec.addons.cloudControllerManager || spec.addons.csiDriver) {
      const config = {
        // CAPMOX's provider ID proxmox://<SystemUUID> (CCM and CSI docs).
        features: { provider: 'capmox' },
        clusters: [
          {
            url: `${d[PROXMOX_SECRET_KEYS.url]}/api2/json`,
            insecure: false,
            token_id: d[PROXMOX_SECRET_KEYS.token],
            token_secret: d[PROXMOX_SECRET_KEYS.secret],
            // Value of topology.kubernetes.io/region on the nodes.
            region: credential.name,
          },
        ],
      };
      // Replaces the containers' trust store: the cluster's CA plus the public roots.
      const ca = [d[PROXMOX_SECRET_KEYS.ca]?.trim(), ...rootCertificates]
        .filter((c): c is string => !!c)
        .join('\n');
      const inner = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: PROXMOX_CLOUD_CONFIG_SECRET, namespace: 'kube-system' },
        type: 'Opaque',
        stringData: { 'config.yaml': stringify(config), 'ca.crt': `${ca}\n` },
      };
      const resourceSet = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: proxmoxCloudConfigName(spec.name), namespace: spec.namespace, labels },
        type: 'addons.cluster.x-k8s.io/resource-set',
        data: {
          'proxmox-cloud-config.yaml': Buffer.from(stringify(inner), 'utf8').toString('base64'),
        },
      };
      objects.push(resourceSet);
      preview.push(masked(resourceSet) as KubernetesObject);
    }
    return { objects, preview };
  }

  /** FP31-F-03: version over verified TLS and the token's effective privileges. */
  async test(
    data: Record<string, string>,
    summary: CredentialSummary,
  ): Promise<CredentialTestResult> {
    const testedAt = new Date().toISOString();
    const checks: CredentialTestResult['checks'] = [];
    let version: string;
    try {
      version = (await this.get<{ version: string }>(data, '/version')).version;
      checks.push({ name: 'Proxmox VE API (TLS verified)', ok: true });
    } catch (err) {
      checks.push({ name: 'Proxmox VE API (TLS verified)', ok: false });
      return { ok: false, testedAt, checks, ...explain(err) };
    }
    const identity = `Proxmox VE ${version} (${summary.tokenId ?? data[PROXMOX_SECRET_KEYS.token]})`;
    let missing: string[] = [];
    try {
      const perms = await this.get<Record<string, Record<string, number>>>(
        data,
        '/access/permissions',
      );
      // Privileges anywhere count: CAPMOX needs them on its pools, storages and bridge only.
      const granted = new Set(Object.values(perms).flatMap((p) => Object.keys(p)));
      missing = PROXMOX_REQUIRED_PRIVILEGES.filter(
        (r) => !granted.has(r.privilege) && !(r.alternatives ?? []).some((a) => granted.has(a)),
      ).map((r) => `${r.privilege} (${r.for})`);
      checks.push({
        name: 'Privileges for CAPMOX, CCM and CSI',
        ok: missing.length === 0,
        ...(missing.length ? { message: `Missing: ${missing.join(', ')}` } : {}),
      });
    } catch (err) {
      checks.push({
        name: 'Privileges for CAPMOX, CCM and CSI',
        ok: false,
        message: explain(err).message,
      });
    }
    try {
      const nodes = await this.get<{ node: string; status?: string }[]>(data, '/nodes');
      const online = nodes.filter((n) => n.status === 'online').map((n) => n.node);
      checks.push({
        name: 'Nodes',
        ok: online.length > 0,
        message: online.length ? `Online: ${online.join(', ')}` : 'No node online',
      });
    } catch (err) {
      checks.push({ name: 'Nodes', ok: false, message: explain(err).message });
    }
    const failed = checks.filter((c) => !c.ok && !c.warning);
    return {
      ok: failed.length === 0,
      testedAt,
      identity,
      checks,
      ...(missing.length
        ? {
            message: `The token lacks ${missing.length} privilege(s)`,
            hint: 'Grant the token user the role PVEVMAdmin on the VMs and PVEDatastoreAdmin on the storages it uses, or PVEAdmin on /; see docs/proxmox.md for the least privileges.',
          }
        : failed.length > 0
          ? { message: `${failed.length} check(s) failed` }
          : {}),
    };
  }

  /** Template names by VM ID, for the cluster detail view. */
  async imageNames(data: Record<string, string>, _summary: CredentialSummary, ids: string[]) {
    const vms = await this.get<Resource[]>(data, '/cluster/resources?type=vm');
    const out: Record<string, string> = {};
    for (const vm of vms) {
      if (ids.includes(String(vm.vmid)) && vm.name) out[String(vm.vmid)] = vm.name;
    }
    return out;
  }

  /**
   * FP31-F-05: CAPMOX asks the guest agent whether cloud-init has finished and only then reports
   * the machine; without the agent, or with a Proxmox cloud-init drive, its machines never become
   * ready (live test: a template with the agent disabled).
   */
  async imageProblems(data: Record<string, string>, ids: string[]) {
    const vms = await this.get<Resource[]>(data, '/cluster/resources?type=vm');
    const out: Record<string, string> = {};
    for (const vm of vms.filter((v) => v.template === 1 && ids.includes(String(v.vmid)))) {
      const config = await this.get<Record<string, string | number>>(
        data,
        `/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.vmid}/config`,
      );
      const warning = templateWarning(config);
      if (warning) out[String(vm.vmid)] = warning;
    }
    return out;
  }

  /**
   * FP31-F-05: selection lists. `region` is the source node for bridges and storages; without it
   * the first online node is used.
   */
  async lookup(
    data: Record<string, string>,
    summary: CredentialSummary,
    kind: LookupKind,
    opts: { region?: string },
  ): Promise<LookupOption[]> {
    const get = <T>(path: string) => this.get<T>(data, path).catch(fail);
    if (kind === 'machineSizes') {
      return (summary.machineSizes ?? DEFAULT_PROXMOX_MACHINE_SIZES).map((s) => ({
        value: s.name,
        label: `${s.name} – ${s.vcpus} vCPU / ${+(s.memoryMiB / 1024).toFixed(1)} GiB`,
        details: { vcpus: s.vcpus, ramGiB: +(s.memoryMiB / 1024).toFixed(1) },
      }));
    }
    const nodes =
      await get<{ node: string; status?: string; maxcpu?: number; maxmem?: number }[]>('/nodes');
    const node =
      opts.region ?? nodes.find((n) => n.status === 'online')?.node ?? nodes[0]?.node ?? '';
    const at = `/nodes/${encodeURIComponent(node)}`;
    switch (kind) {
      case 'nodes':
        return nodes
          .map((n) => ({
            value: n.node,
            label: n.node,
            details: {
              status: n.status ?? 'unknown',
              ...(n.maxcpu ? { vcpus: n.maxcpu } : {}),
              ...(n.maxmem ? { ramGiB: Math.round(n.maxmem / 2 ** 30) } : {}),
            },
          }))
          .sort((a, b) => a.value.localeCompare(b.value));
      case 'templates': {
        const vms = (await get<Resource[]>('/cluster/resources?type=vm')).filter(
          (v) => v.template === 1,
        );
        const out: LookupOption[] = [];
        for (const vm of vms.sort((a, b) => a.vmid - b.vmid)) {
          const config = await get<Record<string, string | number>>(
            `/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.vmid}/config`,
          );
          const warning = templateWarning(config);
          out.push({
            value: String(vm.vmid),
            label: `${vm.vmid} – ${vm.name ?? 'template'}`,
            details: { node: vm.node, ...(warning ? { warning } : {}) },
          });
        }
        return out;
      }
      case 'bridges': {
        const ifaces = await get<{ iface: string; type: string; cidr?: string; active?: number }[]>(
          `${at}/network`,
        );
        return ifaces
          .filter((i) => i.type === 'bridge' || i.type === 'OVSBridge')
          .map((i) => ({
            value: i.iface,
            label: i.iface,
            ...(i.cidr ? { details: { cidr: i.cidr } } : {}),
          }))
          .sort((a, b) => a.value.localeCompare(b.value));
      }
      case 'storages': {
        const storages = await get<
          { storage: string; type: string; content?: string; shared?: number; avail?: number }[]
        >(`${at}/storage?enabled=1`);
        return storages
          .map((st) => ({
            value: st.storage,
            label: st.storage,
            details: {
              type: st.type,
              content: st.content ?? '',
              shared: st.shared === 1,
              ...(st.avail ? { availGiB: Math.round(st.avail / 2 ** 30) } : {}),
            },
          }))
          .sort((a, b) => a.value.localeCompare(b.value));
      }
      default:
        return [];
    }
  }

  private async get<T>(data: Record<string, string>, path: string): Promise<T> {
    const url = data[PROXMOX_SECRET_KEYS.url] ?? '';
    const ca = data[PROXMOX_SECRET_KEYS.ca];
    let res;
    try {
      res = await this.http(`${url}/api2/json${path}`, {
        headers: {
          Authorization: `PVEAPIToken=${data[PROXMOX_SECRET_KEYS.token]}=${data[PROXMOX_SECRET_KEYS.secret]}`,
        },
        ...(ca ? { ca } : {}),
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      throw new ProxmoxApiError(err instanceof Error ? err.message : String(err), undefined, code);
    }
    if (res.status >= 300) {
      throw new ProxmoxApiError(
        res.status === 401 ? 'The token was rejected' : `HTTP ${res.status}`,
        res.status,
      );
    }
    return (JSON.parse(res.body) as { data: T }).data;
  }
}

/** FP31-F-05: what makes a template unusable for CAPMOX (spike findings, ADR-0027). */
export function templateWarning(config: Record<string, string | number>): string | undefined {
  const problems: string[] = [];
  const cloudInitDrive = Object.entries(config).find(
    ([k, v]) => /^(ide|sata|scsi|virtio)\d+$/.test(k) && /cloudinit/.test(String(v)),
  );
  if (cloudInitDrive) {
    problems.push(
      `has a cloud-init drive (${cloudInitDrive[0]}); remove it, CAPMOX brings its own (qm set <id> --delete ${cloudInitDrive[0]})`,
    );
  }
  const agent = String(config.agent ?? '');
  if (!/^(1|enabled=1)/.test(agent)) {
    problems.push('has the QEMU guest agent disabled (qm set <id> --agent enabled=1)');
  }
  // Clones keep the template's boot order (CAPMOX only adds its ISO); without a disk in it the
  // VM tries the network and the ISO and never boots (live test FP-33, 2026-10-24).
  const order = /^order=([^,]*)/.exec(String(config.boot ?? ''))?.[1];
  if (order !== undefined) {
    const disks = order
      .split(';')
      .filter(
        (d) =>
          /^(ide|sata|scsi|virtio)\d+$/.test(d) &&
          !/media=cdrom|cloudinit/.test(String(config[d] ?? '')) &&
          config[d] !== undefined,
      );
    if (!disks.length) {
      const disk = Object.keys(config).find(
        (k) =>
          /^(scsi|virtio|sata)\d+$/.test(k) && !/media=cdrom|cloudinit/.test(String(config[k])),
      );
      problems.push(
        `has no disk in its boot order (${order || 'empty'}); add the boot disk (qm set <id> --boot order=${disk ?? 'scsi0'})`,
      );
    }
  }
  return problems.length ? `Template ${problems.join('; ')}` : undefined;
}

function fail(err: unknown): never {
  const { message, hint } = explain(err);
  throw new CredentialInputError(message, hint);
}

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
]);

/** Understandable messages for Proxmox API errors (no secrets). */
function explain(err: unknown): { message: string; hint?: string } {
  if (err instanceof CredentialInputError) {
    return { message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
  }
  if (err instanceof ProxmoxApiError) {
    if (err.code && TLS_CODES.has(err.code)) {
      return {
        message: `The certificate of the Proxmox API is not trusted (${err.code})`,
        hint: 'Add the CA certificate of the Proxmox cluster (/etc/pve/pve-root-ca.pem on a node).',
      };
    }
    if (err.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
      return {
        message: 'The certificate of the Proxmox API does not match the URL',
        hint: 'Use the host name or IP address the certificate was issued for.',
      };
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
      return {
        message: `The Proxmox API is not reachable (${err.code})`,
        hint: 'Check the URL and port (default 8006) and that the backend can reach it.',
      };
    }
    if (err.status === 401) {
      return {
        message: 'The token was rejected',
        hint: 'Check token ID and secret; the token may be expired or deleted.',
      };
    }
    if (err.status === 403) return { message: `No permission: ${err.message}` };
    return { message: err.message };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}
