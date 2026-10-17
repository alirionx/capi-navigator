import { AWS_IDENTITY, CAPA_IAM } from '../credentials.js';
import type { ManifestObject } from '../operator-manifests.js';
import type { InfraTransformPlugin } from './plugins.js';
import type { AwsInfra, MachineGroup } from './spec.js';
import { compact } from './util.js';

/**
 * AWS (CAPA v2.13.1, infrastructure.cluster.x-k8s.io/v1beta2). Field names verified against
 * api/v1beta2/awscluster_types.go, awsmachine_types.go, network_types.go and types.go; security
 * rules for RKE2 follow the RKE2 provider's AWS example (v0.26.0, examples/templates/aws).
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

  infraCluster(spec, infra, _ctx, labels): ManifestObject {
    const fromRke2Nodes = {
      sourceSecurityGroupRoles: ['node', 'controlplane', 'apiserver-lb', 'lb'],
    };
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
        network: {
          // Dedicated VPC per cluster (FP5-F-16).
          vpc: {
            cidrBlock: infra.network.vpcCidr,
            availabilityZoneUsageLimit: infra.network.availabilityZoneCount,
          },
          // Calico (RKE2 serverConfig.cni) between nodes.
          cni: {
            cniIngressRules: [
              tcp(179, 'BGP'),
              { description: 'IP-in-IP', fromPort: -1, toPort: 65535, protocol: '4' },
              tcp(5473, 'Calico Typha'),
              tcp(9098, 'Calico Typha health check'),
              tcp(9099, 'Calico health check'),
            ],
          },
          // Only the RKE2 supervisor port: CAPA already allows etcd and the API between control
          // plane nodes, and AWS rejects duplicate permissions in one security group.
          additionalControlPlaneIngressRules: [tcp(9345, 'RKE2 supervisor', fromRke2Nodes)],
        },
        // NLB for the API server. CAPA copies NLB ingress rules into the control plane security
        // group, so 9345 must only appear once (above); nodes register via internal IPs
        // (registrationMethod internal-first), so the NLB needs no 9345 listener.
        controlPlaneLoadBalancer: {
          loadBalancerType: 'nlb',
          ingressRules: [tcp(6443, 'Kubernetes API', { cidrBlocks: ['0.0.0.0/0'] })],
        },
        bastion: { enabled: false },
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
      rootVolume: { size: group.rootVolumeSizeGB ?? 50, type: 'gp3' },
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

  addonLabels(spec) {
    return {
      ...(spec.addons.cloudControllerManager ? { 'capi-navigator.io/ccm': 'aws' } : {}),
      ...(spec.addons.csiDriver ? { 'capi-navigator.io/csi': 'aws' } : {}),
    };
  },

  extraObjects: () => [],
};
