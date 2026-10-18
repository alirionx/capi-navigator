import { AWS_IDENTITY, CAPA_IAM } from '../credentials.js';
import type { ManifestObject } from '../operator-manifests.js';
import type { InfraTransformPlugin } from './plugins.js';
import type { AwsInfra, MachineGroup } from './spec.js';
import { compact } from './util.js';

/**
 * AWS (CAPA v2.13.1, infrastructure.cluster.x-k8s.io/v1beta2). Field names verified against
 * api/v1beta2/awscluster_types.go, awsmachine_types.go, network_types.go and types.go; ports and
 * CNI rules come from the Kubernetes distribution (ADR-0012).
 */
export const AWS_API_VERSION = 'infrastructure.cluster.x-k8s.io/v1beta2';

const tcp = (port: number, description: string, extra: Record<string, unknown> = {}) => ({
  description,
  fromPort: port,
  toPort: port,
  protocol: 'tcp',
  ...extra,
});

export const awsPlugin: InfraTransformPlugin<AwsInfra> = {
  provider: 'aws',
  infraClusterKind: 'AWSCluster',
  machineTemplateKind: 'AWSMachineTemplate',
  apiVersion: AWS_API_VERSION,

  infraCluster(spec, infra, _ctx, labels, network): ManifestObject {
    const fromNodes = {
      sourceSecurityGroupRoles: ['node', 'controlplane', 'apiserver-lb', 'lb'],
    };
    const direct = network.controlPlanePorts.filter((p) => !p.viaLoadBalancer);
    const viaLb = network.controlPlanePorts.filter((p) => p.viaLoadBalancer);
    return {
      apiVersion: AWS_API_VERSION,
      kind: 'AWSCluster',
      metadata: { name: spec.name, namespace: spec.namespace, labels },
      spec: compact({
        region: infra.region,
        // ADR-0002: credentials as cluster-scoped identity.
        identityRef: { kind: AWS_IDENTITY.kind, name: infra.credentialRef },
        // CAPA defaults a missing sshKeyName to "default"; an empty string means no key pair.
        sshKeyName: infra.sshKeyName ?? '',
        network: compact({
          // Dedicated VPC per cluster (FP5-F-16).
          vpc: {
            cidrBlock: infra.network.vpcCidr,
            availabilityZoneUsageLimit: infra.network.availabilityZoneCount,
          },
          // CNI traffic of the distribution between nodes (ADR-0012).
          cni: {
            cniIngressRules: network.nodeTraffic.map((r) => ({
              description: r.description,
              fromPort: r.fromPort,
              toPort: r.toPort,
              protocol: r.protocol,
            })),
          },
          // Control plane ports reached directly: CAPA already allows etcd and the API between
          // control plane nodes, and AWS rejects duplicate permissions in one security group.
          additionalControlPlaneIngressRules: direct.length
            ? direct.map((p) => tcp(p.port, p.description, fromNodes))
            : undefined,
        }),
        // NLB for the API server and the distribution's ports behind it. CAPA copies NLB ingress
        // rules into the control plane security group, so each port appears only once.
        controlPlaneLoadBalancer: compact({
          loadBalancerType: 'nlb',
          ingressRules: [
            tcp(6443, 'Kubernetes API', { cidrBlocks: ['0.0.0.0/0'] }),
            ...viaLb.map((p) => tcp(p.port, p.description, fromNodes)),
          ],
          additionalListeners: viaLb.length
            ? viaLb.map((p) => ({ port: p.port, protocol: 'TCP' }))
            : undefined,
        }),
        // FP5-F-20: CAPA restricts SSH to the bastion to the allowed networks and lets the
        // nodes accept SSH from the bastion.
        bastion: infra.bastion?.enabled
          ? compact({
              enabled: true,
              allowedCIDRBlocks: infra.bastion.allowedCidrs,
              instanceType: infra.bastion.machineSize,
              ami: infra.bastion.image,
            })
          : { enabled: false },
      }),
    };
  },

  machineTemplateSpec(_spec, infra, group: MachineGroup, role) {
    return compact({
      ami: { id: group.image ?? infra.image },
      instanceType: group.machineSize,
      // IAM instance profiles from clusterawsadm (FP4-F-09); also used by CCM and EBS CSI.
      iamInstanceProfile: `${role === 'control-plane' ? 'control-plane' : 'nodes'}${CAPA_IAM.suffix}`,
      sshKeyName: infra.sshKeyName ?? '',
      // FP5-F-19: EBS root volume.
      rootVolume: { size: group.rootVolumeSizeGB ?? 50, type: group.rootVolumeType ?? 'gp3' },
      // ADR-0003: stock AMIs lack the aws CLI for the Secrets Manager boothook.
      cloudInit: { insecureSkipSecretsManager: true },
      instanceMetadataOptions: {
        httpEndpoint: 'enabled',
        httpTokens: 'required',
        // ADR-0003: pods (EBS CSI controller) need IMDS for instance profile credentials.
        httpPutResponseHopLimit: 2,
      },
    });
  },

  nodeIdentity: {
    providerId: 'aws:///{{ v1.availability_zone }}/{{ v1.instance_id }}',
    // The AWS CCM expects the private DNS name as node name.
    nodeName: '{{ v1.local_hostname }}',
  },

  resources: {
    infraClusterPlural: 'awsclusters',
    machineKind: 'AWSMachine',
    machinePlural: 'awsmachines',
    machineTemplatePlural: 'awsmachinetemplates',
  },

  machineDetails(s) {
    const ami = s.ami as { id?: string } | undefined;
    const root = s.rootVolume as { size?: number; type?: string } | undefined;
    return compact({
      size: typeof s.instanceType === 'string' ? s.instanceType : undefined,
      image: ami?.id,
      rootVolumeGB: root?.size,
      rootVolumeType: root?.type,
    });
  },

  bastionStatus(st) {
    const b = st.bastion as
      { publicIp?: string; privateIp?: string; instanceState?: string } | undefined;
    return compact({ publicIP: b?.publicIp, privateIP: b?.privateIp, state: b?.instanceState });
  },

  infraFacts: (infra) => [
    { label: 'Region', value: infra.region },
    { label: 'VPC network', value: infra.network.vpcCidr },
    { label: 'Availability zones', value: String(infra.network.availabilityZoneCount) },
    { label: 'API server', value: 'Network load balancer' },
    ...(infra.sshKeyName ? [{ label: 'SSH key pair', value: infra.sshKeyName }] : []),
  ],

  addonLabels(spec) {
    return {
      ...(spec.addons.cloudControllerManager ? { 'capi-navigator.io/ccm': 'aws' } : {}),
      ...(spec.addons.csiDriver ? { 'capi-navigator.io/csi': 'aws' } : {}),
    };
  },

  extraObjects: () => [],
};
