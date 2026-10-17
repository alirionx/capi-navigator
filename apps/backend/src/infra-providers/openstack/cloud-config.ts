import type { KubernetesObject } from '@kubernetes/client-node';
import {
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  openstackCloudConfigSecretName,
  type ClusterSpec,
  type OpenStackInfra,
} from '@capi-navigator/shared';
import { stringify } from 'yaml';
import { cloudAuthType, type CloudEntry } from './clouds-yaml.js';

/**
 * cloud.conf for the OpenStack CCM and Cinder CSI (FP5-F-10). Keys per
 * cloud-provider-openstack docs (using-openstack-cloud-controller-manager.md).
 */
export function buildCloudConf(cloud: CloudEntry, infra: OpenStackInfra, hasCa: boolean): string {
  const a = cloud.auth;
  const global: [string, string | undefined][] = [['auth-url', a.auth_url]];
  if (cloudAuthType(cloud) === 'v3applicationcredential') {
    global.push(['application-credential-id', a.application_credential_id]);
    global.push(['application-credential-secret', a.application_credential_secret]);
  } else {
    global.push(['username', a.username], ['password', a.password]);
    global.push(
      ['tenant-name', a.project_name],
      ['tenant-domain-name', a.project_domain_name ?? 'Default'],
    );
    global.push(['user-domain-name', a.user_domain_name ?? 'Default']);
  }
  global.push(['region', cloud.region_name]);
  if (hasCa) global.push(['ca-file', '/etc/config/ca.crt']);
  const section = (name: string, entries: [string, string | undefined][]) =>
    `[${name}]\n${entries
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${quote(v!)}`)
      .join('\n')}\n`;
  return `${section('Global', global)}\n${section('LoadBalancer', [['floating-network-id', infra.externalNetwork]])}`;
}

/** gcfg values: quote when needed so secrets with special characters survive. */
function quote(value: string): string {
  return /^[A-Za-z0-9._:/@-]+$/.test(value)
    ? value
    : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The Secret a ClusterResourceSet applies into the workload cluster (ADR-0004): it contains the
 * manifest of kube-system/cloud-config. Lives in the cluster's namespace on the management cluster.
 */
export function buildCloudConfigResourceSetSecret(
  spec: ClusterSpec,
  cloudConf: string,
  cacert: string | undefined,
): KubernetesObject & { type: string; data: Record<string, string> } {
  const inner = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'cloud-config', namespace: 'kube-system' },
    type: 'Opaque',
    stringData: { 'cloud.conf': cloudConf, ...(cacert ? { 'ca.crt': cacert } : {}) },
  };
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: openstackCloudConfigSecretName(spec.name),
      namespace: spec.namespace,
      labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, 'cluster.x-k8s.io/cluster-name': spec.name },
    },
    type: 'addons.cluster.x-k8s.io/resource-set',
    data: { 'cloud-config.yaml': Buffer.from(stringify(inner), 'utf8').toString('base64') },
  };
}
