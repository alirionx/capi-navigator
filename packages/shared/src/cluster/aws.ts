import { AWS_IDENTITY, CAPA_IAM } from '../credentials.js';
import type { ManifestObject } from '../operator-manifests.js';
import { ubuntuImage } from './infra-form.js';
import type { InfraTransformPlugin } from './plugins.js';
import { AWS_ROOT_VOLUME_TYPES, type AwsInfra, type MachineGroup } from './spec.js';
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

/**
 * Rules CAPA v2.13.1 already creates in the node security group (securitygroups.go: "Kubelet API"
 * from control plane and nodes). CNI rules go into the node and control plane groups, and AWS
 * rejects a permission given twice, so these only go to the control plane group.
 */
const inNodeGroup = (r: { protocol: string; fromPort: number; toPort: number }) =>
  r.protocol === 'tcp' && r.fromPort === 10250 && r.toPort === 10250;

export const awsPlugin: InfraTransformPlugin<AwsInfra> = {
  provider: 'aws',
  infraClusterKind: 'AWSCluster',
  machineTemplateKind: 'AWSMachineTemplate',
  apiVersion: AWS_API_VERSION,

  form: {
    displayName: 'AWS',
    lookups: [
      { kind: 'instanceTypes' },
      { kind: 'images' },
      { kind: 'keyPairs' },
      { kind: 'regions' },
    ],
    regionField: 'region',
    fields: [
      {
        path: 'region',
        kind: 'autocomplete',
        lookup: 'regions',
        label: 'wizard.region',
        hint: 'wizard.regionHint',
        fromCredential: (summary) => summary.region,
        resets: ['image'],
        cols: 4,
      },
      {
        path: 'image',
        kind: 'autocomplete',
        lookup: 'images',
        label: 'wizard.ami',
        hint: 'wizard.amiHint',
        preselect: ubuntuImage,
        cols: 8,
        testId: 'image',
      },
      {
        path: 'network.vpcCidr',
        kind: 'text',
        label: 'wizard.vpcCidr',
        hint: 'wizard.vpcCidrHint',
        default: '10.0.0.0/16',
        cols: 4,
      },
      {
        path: 'network.availabilityZoneCount',
        kind: 'select',
        options: [1, 2, 3],
        label: 'wizard.azCount',
        hint: 'wizard.azCountHint',
        default: 1,
        cols: 4,
      },
      {
        path: 'sshKeyName',
        kind: 'select',
        lookup: 'keyPairs',
        label: 'wizard.sshKey',
        hint: 'wizard.sshKeyHint',
        clearable: true,
        cols: 4,
      },
    ],
    notes: ['wizard.awsLbInfo'],
    keyPairField: 'sshKeyName',
    machine: {
      sizeLookup: 'instanceTypes',
      sizeLabel: 'wizard.machineSize.aws',
      target: 'AWSMachineTemplate',
      sizeField: 'instanceType',
      rootVolume: {
        defaultGB: 50,
        defaultType: 'gp3',
        types: { options: AWS_ROOT_VOLUME_TYPES },
        typeHint: 'wizard.rootVolumeTypeAws',
      },
    },
    bastion: {
      sizeLabel: 'bastion.size.aws',
      sizeHint: 'bastion.sizeHintAws',
      sizeRequired: false,
      allowedCidrs: true,
      // CAPA's default bastion AMI is Ubuntu.
      sshUser: 'ubuntu',
    },
  },

  infraCluster(spec, infra, _ctx, labels, network): ManifestObject {
    const fromNodes = {
      sourceSecurityGroupRoles: ['node', 'controlplane', 'apiserver-lb', 'lb'],
    };
    const direct = network.controlPlanePorts.filter((p) => !p.viaLoadBalancer);
    const viaLb = network.controlPlanePorts.filter((p) => p.viaLoadBalancer);
    const controlPlaneOnly = network.nodeTraffic.filter(inNodeGroup);
    const controlPlaneRules = [
      ...direct.map((p) => tcp(p.port, p.description, fromNodes)),
      ...controlPlaneOnly.map((r) =>
        tcp(r.fromPort, r.description, { sourceSecurityGroupRoles: ['node', 'controlplane'] }),
      ),
    ];
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
            cniIngressRules: network.nodeTraffic
              .filter((r) => !inNodeGroup(r))
              .map((r) => ({
                description: r.description,
                fromPort: r.fromPort,
                toPort: r.toPort,
                protocol: r.protocol,
              })),
          },
          // Control plane ports reached directly: CAPA already allows etcd and the API between
          // control plane nodes, and AWS rejects duplicate permissions in one security group.
          additionalControlPlaneIngressRules: controlPlaneRules.length
            ? controlPlaneRules
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
      // So the user data goes to EC2 directly, limited to 16 KB; a kubeadm control plane with
      // its CA keys and install script needs about 18 KB. CAPA gzips only with an explicit
      // false (unset means uncompressed); cloud-init unpacks it.
      uncompressedUserData: false,
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
