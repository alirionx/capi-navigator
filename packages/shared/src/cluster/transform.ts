import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, type ManifestObject } from '../operator-manifests.js';
import { CNI_LABEL, REBOOT_DAEMON_LABEL } from './addons.js';
import { awsPlugin } from './aws.js';
import { gcpPlugin } from './gcp.js';
import { openstackPlugin } from './openstack.js';
import type {
  BootstrapFlavorPlugin,
  InfraTransformPlugin,
  ObjectRef,
  TransformContext,
} from './plugins.js';
import { k0sPlugin } from './k0s.js';
import { kubeadmPlugin } from './kubeadm.js';
import { rke2Plugin } from './rke2.js';
import { CLUSTER_SPEC_ANNOTATION, type ClusterSpec, type Infrastructure } from './spec.js';
import { shortHash, stableStringify } from './util.js';

export type { TransformContext } from './plugins.js';

/** Registries: new providers and distributions plug in here without changing the core (hard rule 10). */
export const INFRA_PLUGINS: Record<Infrastructure['provider'], InfraTransformPlugin> = {
  openstack: openstackPlugin as InfraTransformPlugin,
  aws: awsPlugin as InfraTransformPlugin,
  gcp: gcpPlugin as InfraTransformPlugin,
};
export const FLAVOR_PLUGINS: Partial<
  Record<ClusterSpec['kubernetes']['flavor'], BootstrapFlavorPlugin>
> = {
  rke2: rke2Plugin,
  k0s: k0sPlugin,
  kubeadm: kubeadmPlugin,
};

const CAPI_API = 'cluster.x-k8s.io/v1beta2';
const CLUSTER_NAME_LABEL = 'cluster.x-k8s.io/cluster-name';

/**
 * Translates a cluster spec into CAPI manifests (section 5). Pure: no I/O, no cluster access;
 * the same input gives byte-identical YAML (hard rule 3). Machine and bootstrap templates are
 * named by a hash of their content, so every machine-affecting change creates new templates
 * instead of editing existing ones (hard rule 5).
 */
export function transform(spec: ClusterSpec, ctx: TransformContext): ManifestObject[] {
  const infra = INFRA_PLUGINS[spec.infrastructure.provider];
  const flavor = FLAVOR_PLUGINS[spec.kubernetes.flavor];
  if (!flavor) throw new Error(`Kubernetes flavor "${spec.kubernetes.flavor}" is not available`);

  const labels = { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, [CLUSTER_NAME_LABEL]: spec.name };
  const infraRef = (name: string): ObjectRef => ({
    apiGroup: 'infrastructure.cluster.x-k8s.io',
    kind: infra.machineTemplateKind,
    name,
  });
  const objects: ManifestObject[] = [];

  // Cluster
  objects.push({
    apiVersion: CAPI_API,
    kind: 'Cluster',
    metadata: {
      name: spec.name,
      namespace: spec.namespace,
      labels: {
        ...sorted(spec.labels ?? {}),
        ...infra.addonLabels(spec),
        ...(spec.addons.rebootDaemon ? Object.fromEntries([REBOOT_DAEMON_LABEL]) : {}),
        ...(flavor.needsCni && spec.addons.cni !== 'none' ? Object.fromEntries([CNI_LABEL]) : {}),
        ...labels,
      },
      annotations: { [CLUSTER_SPEC_ANNOTATION]: stableStringify(spec) },
    },
    spec: {
      clusterNetwork: {
        // ADR-0022: the port the API load balancer listens on, where the provider takes it.
        ...(infra.apiLoadBalancer ? { apiServerPort: infra.apiLoadBalancer.port } : {}),
        pods: { cidrBlocks: [spec.kubernetes.podCidr] },
        services: { cidrBlocks: [spec.kubernetes.serviceCidr] },
      },
      controlPlaneRef: flavor.controlPlaneRef(spec),
      infrastructureRef: {
        apiGroup: 'infrastructure.cluster.x-k8s.io',
        kind: infra.infraClusterKind,
        name: spec.name,
      },
    },
  });

  // Infrastructure cluster
  objects.push(infra.infraCluster(spec, spec.infrastructure, ctx, labels, flavor.network));

  // Control plane
  const cpTemplateSpec = infra.machineTemplateSpec(
    spec,
    spec.infrastructure,
    spec.topology.controlPlane,
    'control-plane',
  );
  // A rebuild (FP7-F-11) changes the template name: control plane providers have no rolloutAfter.
  const cpRebuild =
    spec.topology.controlPlane.rebuildRequestedAt ?? spec.rollout.rebuildRequestedAt;
  const cpTemplateName = `${spec.name}-cp-${shortHash(
    cpRebuild ? { spec: cpTemplateSpec, rebuild: cpRebuild } : cpTemplateSpec,
  )}`;
  objects.push(machineTemplate(infra, spec, cpTemplateName, cpTemplateSpec, labels));
  objects.push(
    flavor.controlPlane({ spec, infra, machineTemplate: infraRef(cpTemplateName), labels }),
  );

  // Worker pools (FP5-F-12), none for all-in-one.
  if (spec.topology.mode === 'standard') {
    for (const pool of spec.topology.workerPools) {
      const machineSpec = infra.machineTemplateSpec(spec, spec.infrastructure, pool, 'worker');
      const bootstrapSpec = flavor.workerBootstrapSpec({ spec, infra, pool });
      const machineName = `${spec.name}-${pool.name}-${shortHash(machineSpec)}`;
      const bootstrapName = `${spec.name}-${pool.name}-${shortHash(bootstrapSpec)}`;
      objects.push(machineTemplate(infra, spec, machineName, machineSpec, labels));
      objects.push({
        apiVersion: flavor.bootstrapTemplate.apiVersion,
        kind: flavor.bootstrapTemplate.kind,
        metadata: { name: bootstrapName, namespace: spec.namespace, labels },
        spec: { template: { spec: bootstrapSpec } },
      });
      const failureDomain = infra.failureDomain?.(spec.infrastructure);
      objects.push({
        apiVersion: CAPI_API,
        kind: 'MachineDeployment',
        metadata: { name: `${spec.name}-${pool.name}`, namespace: spec.namespace, labels },
        spec: {
          clusterName: spec.name,
          replicas: pool.replicas,
          rollout: {
            // FP7-F-11: machines created before this time are replaced.
            ...((pool.rebuildRequestedAt ?? spec.rollout.rebuildRequestedAt)
              ? { after: pool.rebuildRequestedAt ?? spec.rollout.rebuildRequestedAt }
              : {}),
            strategy: {
              type: 'RollingUpdate',
              rollingUpdate: {
                maxSurge: pool.rollout?.maxSurge ?? spec.rollout.maxSurge,
                maxUnavailable: pool.rollout?.maxUnavailable ?? spec.rollout.maxUnavailable,
              },
            },
          },
          selector: {
            matchLabels: { [CLUSTER_NAME_LABEL]: spec.name, 'capi-navigator.io/pool': pool.name },
          },
          template: {
            metadata: {
              labels: { [CLUSTER_NAME_LABEL]: spec.name, 'capi-navigator.io/pool': pool.name },
            },
            spec: {
              clusterName: spec.name,
              // FP7-F-08: workers follow the control plane only after it was upgraded.
              version: machineVersion(
                flavor,
                spec.kubernetes.workerVersion ?? spec.kubernetes.version,
              ),
              bootstrap: {
                configRef: {
                  apiGroup: flavor.bootstrapTemplate.apiGroup,
                  kind: flavor.bootstrapTemplate.kind,
                  name: bootstrapName,
                },
              },
              infrastructureRef: infraRef(machineName),
              ...(failureDomain ? { failureDomain } : {}),
            },
          },
        },
      });
    }
  }

  objects.push(...infra.extraObjects(spec, spec.infrastructure, labels));
  return objects;
}

function machineTemplate(
  infra: InfraTransformPlugin,
  spec: ClusterSpec,
  name: string,
  templateSpec: Record<string, unknown>,
  labels: Record<string, string>,
): ManifestObject {
  return {
    apiVersion: infra.apiVersion,
    kind: infra.machineTemplateKind,
    metadata: { name, namespace: spec.namespace, labels },
    spec: { template: { spec: templateSpec } },
  };
}

function sorted(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function machineVersion(flavor: BootstrapFlavorPlugin, version: string): string {
  return flavor.machineVersion?.(version) ?? version;
}
