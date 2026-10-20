import type { ManifestObject } from '../operator-manifests.js';
import { ubuntuImage } from './infra-form.js';
import type { InfraTransformPlugin } from './plugins.js';
import { GCP_ROOT_DISK_TYPES, type GcpInfra, type MachineGroup } from './spec.js';
import { compact } from './util.js';

/**
 * Google Cloud (CAPG v1.13.1, infrastructure.cluster.x-k8s.io/v1beta1, still the CAPI v1beta1
 * contract). Field names verified against api/v1beta1/gcpcluster_types.go, gcpmachine_types.go
 * and types.go; defaults against cloud/scope (cluster.go, machine.go, firewall.go).
 */
export const GCP_API_VERSION = 'infrastructure.cluster.x-k8s.io/v1beta1';

/** Namespace of the CAPG provider, where the app stores the credential Secrets. */
export const GCP_PROVIDER_NAMESPACE = 'capg-system';

/** The one subnet of a cluster's dedicated network. */
export const gcpSubnetName = (cluster: string) => `${cluster}-nodes`;

export const gcpPlugin: InfraTransformPlugin<GcpInfra> = {
  provider: 'gcp',
  infraClusterKind: 'GCPCluster',
  machineTemplateKind: 'GCPMachineTemplate',
  apiVersion: GCP_API_VERSION,

  form: {
    displayName: 'Google Cloud',
    lookups: [{ kind: 'machineTypes' }, { kind: 'images' }, { kind: 'regions' }, { kind: 'zones' }],
    regionField: 'region',
    fields: [
      {
        path: 'project',
        kind: 'text',
        label: 'wizard.gcpProject',
        hint: 'wizard.gcpProjectHint',
        fromCredential: (summary) => summary.projectId,
        cols: 4,
      },
      {
        path: 'region',
        kind: 'autocomplete',
        lookup: 'regions',
        label: 'wizard.region',
        hint: 'wizard.gcpRegionHint',
        fromCredential: (summary) => summary.region,
        resets: ['zone'],
        cols: 4,
      },
      {
        path: 'zone',
        kind: 'select',
        lookup: 'zones',
        label: 'wizard.gcpZone',
        hint: 'wizard.gcpZoneHint',
        clearable: true,
        cols: 4,
      },
      {
        path: 'image',
        kind: 'autocomplete',
        lookup: 'images',
        label: 'wizard.image',
        hint: 'wizard.gcpImageHint',
        preselect: ubuntuImage,
        cols: 8,
        testId: 'image',
      },
      {
        path: 'network.nodeCidr',
        kind: 'text',
        label: 'wizard.nodeCidr',
        hint: 'wizard.gcpNodeCidrHint',
        default: '10.6.0.0/24',
        cols: 4,
      },
      {
        path: 'controlPlaneServiceAccount',
        kind: 'text',
        label: 'wizard.gcpServiceAccount',
        hint: 'wizard.gcpServiceAccountHint',
        fromCredential: (summary) => summary.serviceAccount,
        clearable: true,
        cols: 12,
      },
    ],
    notes: ['wizard.gcpLbInfo'],
    machine: {
      sizeLookup: 'machineTypes',
      sizeLabel: 'wizard.machineSize.gcp',
      target: 'GCPMachineTemplate',
      sizeField: 'instanceType',
      rootVolume: {
        defaultGB: 30,
        defaultType: 'pd-standard',
        sizeHint: 'wizard.rootVolumeHintGcp',
        types: { options: GCP_ROOT_DISK_TYPES },
        typeHint: 'wizard.rootVolumeTypeGcp',
      },
    },
  },

  // ADR-0022: CAPG's API load balancer is a global TCP proxy with a single forwarding rule. It
  // listens on Cluster.spec.clusterNetwork.apiServerPort (default 443) and checks HTTPS /readyz
  // on 6443 without credentials. 6443 keeps the endpoint where k0s expects it.
  apiLoadBalancer: { port: 6443, apiPortOnly: true, anonymousHealthCheck: true },

  // GCE hands out the FQDN (<instance>.<zone>.c.<project>.internal) as hostname. k0s labels its
  // etcd member with "k0s-ctrl-<hostname>", which exceeds 63 characters and stops k0s (seen live).
  // A static short hostname wins over the DHCP one and survives lease renewals and reboots.
  nodePreparation: ['hostnamectl set-hostname "$(hostname -s)"'],

  infraCluster(spec, infra, ctx, labels) {
    // CAPG creates allow-<cluster>-healthchecks and allow-<cluster>-cluster (all traffic between
    // the cluster's machines), so the distribution's ports need no extra rules (ADR-0012).
    return {
      apiVersion: GCP_API_VERSION,
      kind: 'GCPCluster',
      metadata: { name: spec.name, namespace: spec.namespace, labels },
      spec: compact({
        project: infra.project,
        region: infra.region,
        credentialsRef: ctx.credential.secret ?? {
          name: `capi-navigator-credential-${infra.credentialRef}`,
          namespace: GCP_PROVIDER_NAMESPACE,
        },
        // A network named after the cluster: CAPG creates it with Cloud NAT and deletes both
        // with the cluster (networks/reconcile.go), so nodes need no public IP.
        network: {
          name: spec.name,
          autoCreateSubnetworks: false,
          subnets: [
            {
              name: gcpSubnetName(spec.name),
              cidrBlock: infra.network.nodeCidr,
              region: infra.region,
            },
          ],
        },
        failureDomains: infra.zone ? [infra.zone] : undefined,
      }),
    };
  },

  machineTemplateSpec(spec, infra, group: MachineGroup, role) {
    return compact({
      instanceType: group.machineSize,
      // Required in a custom-mode network: CAPG sends an empty subnetwork otherwise, which
      // Google rejects (InstanceNetworkInterfaceSpec in cloud/scope/machine.go, seen live).
      subnet: gcpSubnetName(spec.name),
      image: group.image ?? infra.image,
      rootDeviceSize: group.rootVolumeSizeGB,
      rootDeviceType: group.rootVolumeType,
      // ADR-0023: CCM and CSI controller on the control plane use this account via the metadata
      // server. CAPG drops its default scope when an account is set, so the scope is explicit.
      serviceAccounts:
        role === 'control-plane' && infra.controlPlaneServiceAccount
          ? {
              email: infra.controlPlaneServiceAccount,
              scopes: ['https://www.googleapis.com/auth/cloud-platform'],
            }
          : undefined,
    });
  },

  failureDomain: (infra) => infra.zone,

  // cloud-init's GCE data source has zone and instance name but not the project (FP25-F-07).
  nodeIdentity: (infra) => ({
    providerId: `gce://${infra.project}/{{ v1.availability_zone }}/{{ v1.local_hostname }}`,
    nodeName: '{{ v1.local_hostname }}',
  }),

  resources: {
    infraClusterPlural: 'gcpclusters',
    machineKind: 'GCPMachine',
    machinePlural: 'gcpmachines',
    machineTemplatePlural: 'gcpmachinetemplates',
  },

  machineDetails(s) {
    return compact({
      size: s.instanceType as string | undefined,
      image: s.image as string | undefined,
      // CAPG defaults (gcpmachine_types.go).
      rootVolumeGB: (s.rootDeviceSize as number | undefined) ?? 30,
      rootVolumeType: (s.rootDeviceType as string | undefined) ?? 'pd-standard',
    });
  },

  bastionStatus: () => ({}),

  infraFacts: (infra) => [
    { label: 'Project', value: infra.project },
    { label: 'Region', value: infra.region },
    ...(infra.zone ? [{ label: 'Zone', value: infra.zone }] : []),
    { label: 'Node network', value: infra.network.nodeCidr },
    { label: 'API server', value: 'Global TCP proxy load balancer' },
  ],

  addonLabels(spec) {
    return {
      ...(spec.addons.cloudControllerManager ? { 'capi-navigator.io/ccm': 'gcp' } : {}),
      ...(spec.addons.csiDriver ? { 'capi-navigator.io/csi': 'gcp' } : {}),
    };
  },

  extraObjects: (): ManifestObject[] => [],
};
