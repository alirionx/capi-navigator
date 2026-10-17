import { z } from 'zod';
import { AwsRegionSchema, CredentialNameSchema } from '../credentials.js';
import { cidrsOverlap, parseIpv4Cidr } from './cidr.js';

/**
 * The cluster spec (section 5 of the requirements): the simplified, typed input model that pure
 * transformations translate into CAPI manifests. It is stored as annotation on the Cluster
 * (FP5-F-07) and stays the source of truth (hard rule 4).
 */

const dnsLabel = (max: number, what: string) =>
  z
    .string()
    .min(1, 'Required')
    .max(max, `At most ${max} characters`)
    .regex(
      /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
      `${what}: lowercase letters, digits and "-"; must start and end with a letter or digit`,
    );

const CidrSchema = z
  .string()
  .trim()
  .refine((v) => !!parseIpv4Cidr(v), 'An IPv4 network in CIDR notation, e.g. 10.42.0.0/16');

/** Label prefixes the app or CAPI set themselves; users cannot set or remove them (FP6-F-07). */
export const RESERVED_LABEL_PREFIXES = ['capi-navigator.io/', 'cluster.x-k8s.io/'] as const;
export const isReservedLabel = (key: string) =>
  RESERVED_LABEL_PREFIXES.some((p) => key.startsWith(p));

const LabelsSchema = z.record(
  z
    .string()
    .regex(/^([a-z0-9.-]+\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/, 'Invalid label key'),
  z
    .string()
    .regex(/^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/, 'Invalid label value')
    .max(63),
);

/** Cluster labels chosen by users: no reserved prefixes (FP6-F-07). */
export const UserLabelsSchema = LabelsSchema.refine(
  (labels) => !Object.keys(labels).some(isReservedLabel),
  `Labels under ${RESERVED_LABEL_PREFIXES.join(' or ')} are reserved`,
);

/** Extra cloud-init configuration per group (FP5-F-13, US-16). Runs as root on the nodes. */
export const NodeCustomizationSchema = z.object({
  files: z
    .array(
      z
        .object({
          path: z.string().regex(/^\/[^\0]*$/, 'An absolute path'),
          /** Inline content; do not put secrets here (FP5-F-14). */
          content: z
            .string()
            .max(64 * 1024)
            .optional(),
          /** Content from a Secret in the cluster's namespace (FP5-F-14 SHOULD). */
          contentFromSecret: z
            .object({ name: z.string().min(1), key: z.string().min(1) })
            .optional(),
          permissions: z
            .string()
            .regex(/^0[0-7]{3}$/, 'Octal like 0644')
            .optional(),
          owner: z.string().max(64).optional(),
        })
        .refine((f) => (f.content !== undefined) !== (f.contentFromSecret !== undefined), {
          message: 'Either inline content or a Secret reference',
        }),
    )
    .max(50)
    .default([]),
  /** Before the Kubernetes installation (RKE2: preRKE2Commands). */
  preCommands: z.array(z.string().min(1).max(4096)).max(50).default([]),
  /** After the Kubernetes installation (RKE2: postRKE2Commands). */
  postCommands: z.array(z.string().min(1).max(4096)).max(50).default([]),
});
export type NodeCustomization = z.infer<typeof NodeCustomizationSchema>;

const MachineGroupFields = {
  /** Flavor (OpenStack) or instance type (AWS). */
  machineSize: z.string().trim().min(1, 'Required').max(255),
  /** Overrides infrastructure.image for this group. */
  image: z.string().trim().max(255).optional(),
  /**
   * Root disk in GB (FP5-F-19). OpenStack: boot from a Cinder volume of this size instead of the
   * flavor's local disk; required for flavors without local disk. AWS: EBS root volume, default 50.
   */
  rootVolumeSizeGB: z.int().min(10).max(4000).optional(),
  /** Cinder volume type (OpenStack) or EBS volume type (AWS, default gp3) of the root disk. */
  rootVolumeType: z.string().trim().min(1).max(255).optional(),
  customization: NodeCustomizationSchema.optional(),
};

export const ControlPlaneSchema = z.object({
  ...MachineGroupFields,
  replicas: z.union([z.literal(1), z.literal(3), z.literal(5)]).default(1),
});

/** Pool names are short so that template names stay within 63 characters (hard rule 5). */
export const WorkerPoolSchema = z.object({
  ...MachineGroupFields,
  name: dnsLabel(12, 'Pool name'),
  replicas: z.int().min(0).max(100).default(2),
  nodeLabels: LabelsSchema.optional(),
});
export type WorkerPool = z.infer<typeof WorkerPoolSchema>;
export type ControlPlane = z.infer<typeof ControlPlaneSchema>;
export type MachineGroup = Pick<
  WorkerPool,
  'machineSize' | 'image' | 'rootVolumeSizeGB' | 'rootVolumeType' | 'customization'
>;

/**
 * EBS volume types that can boot an instance without extra settings. st1/sc1 cannot be root
 * volumes; io1/io2 need provisioned IOPS (not offered yet).
 */
export const AWS_ROOT_VOLUME_TYPES = ['gp3', 'gp2'] as const;

/**
 * Bastion host for SSH access to the nodes (FP5-F-20). Both providers attach a cloud key pair
 * (`sshKeyName`); CAPA restricts SSH to `allowedCidrs`, CAPO v0.15 opens SSH to the bastion to
 * everyone (not configurable), so OpenStack takes no CIDRs.
 */
export const BastionSchema = z.object({
  enabled: z.boolean().default(false),
  /** Flavor (OpenStack, required) or instance type (AWS, default by CAPA). */
  machineSize: z.string().trim().min(1).max(255).optional(),
  /** Image ID / AMI; default: the cluster image (OpenStack) or CAPA's bastion AMI (AWS). */
  image: z.string().trim().min(1).max(255).optional(),
  /** Source networks allowed to SSH to the bastion (AWS only). */
  allowedCidrs: z.array(CidrSchema).max(20).optional(),
});
export type Bastion = z.infer<typeof BastionSchema>;

export const OpenStackInfraSchema = z.object({
  provider: z.literal('openstack'),
  /** Stored credentials = OpenStackClusterIdentity (FP-4, ADR-0002). */
  credentialRef: CredentialNameSchema,
  /** Image ID (FP4-F-05 list); CAPO requires a UUID. */
  image: z.uuid('An image ID (UUID) from the image list'),
  /** External network ID for router and floating IPs; CAPO requires a UUID. */
  externalNetwork: z.uuid('A network ID (UUID) from the external network list'),
  network: z
    .object({
      nodeCidr: CidrSchema.default('10.6.0.0/24'),
      dnsNameservers: z.array(z.ipv4()).min(1).max(5).default(['1.1.1.1', '8.8.8.8']),
    })
    .default({ nodeCidr: '10.6.0.0/24', dnsNameservers: ['1.1.1.1', '8.8.8.8'] }),
  /** Octavia load balancer for the API server. */
  apiServerLoadBalancer: z.boolean().default(true),
  failureDomain: z.string().trim().max(255).optional(),
  sshKeyName: z.string().trim().max(255).optional(),
  bastion: BastionSchema.optional(),
});
export type OpenStackInfra = z.infer<typeof OpenStackInfraSchema>;

export const AwsInfraSchema = z.object({
  provider: z.literal('aws'),
  /** Stored credentials = AWSClusterStaticIdentity (FP-4, ADR-0002). */
  credentialRef: CredentialNameSchema,
  region: AwsRegionSchema,
  /** AMI ID (FP4-F-10 list). */
  image: z.string().regex(/^ami-[0-9a-f]{8,17}$/, 'An AMI ID like ami-0123456789abcdef0'),
  network: z
    .object({
      vpcCidr: CidrSchema.default('10.0.0.0/16'),
      /** Number of availability zones for subnets (CAPA availabilityZoneUsageLimit). */
      availabilityZoneCount: z.int().min(1).max(3).default(1),
    })
    .default({ vpcCidr: '10.0.0.0/16', availabilityZoneCount: 1 }),
  /** CAPA always needs a load balancer for the control plane endpoint. */
  apiServerLoadBalancer: z.literal(true).default(true),
  sshKeyName: z.string().trim().max(255).optional(),
  bastion: BastionSchema.optional(),
});
export type AwsInfra = z.infer<typeof AwsInfraSchema>;

export const InfrastructureSchema = z.discriminatedUnion('provider', [
  OpenStackInfraSchema,
  AwsInfraSchema,
]);
export type Infrastructure = z.infer<typeof InfrastructureSchema>;

export const KubernetesFlavorSchema = z.enum(['rke2', 'k0s', 'kubeadm']);

export const ClusterSpecSchema = z
  .object({
    name: dnsLabel(40, 'Cluster name'),
    namespace: dnsLabel(63, 'Namespace').default('default'),
    /** Set on the Cluster; used to assign Helm add-ons (FP-8). */
    labels: UserLabelsSchema.optional(),
    kubernetes: z.object({
      flavor: KubernetesFlavorSchema.default('rke2'),
      version: z.string().regex(/^v\d+\.\d+\.\d+\+[a-z0-9.]+$/, 'A version like v1.35.9+rke2r1'),
      podCidr: CidrSchema.default('10.42.0.0/16'),
      serviceCidr: CidrSchema.default('10.43.0.0/16'),
    }),
    topology: z.object({
      mode: z.enum(['standard', 'all-in-one']).default('standard'),
      controlPlane: ControlPlaneSchema,
      workerPools: z.array(WorkerPoolSchema).max(10).default([]),
    }),
    rollout: z
      .object({
        /** ISO timestamp; changing it rebuilds all nodes (FP-7). */
        rebuildRequestedAt: z.string().optional(),
        maxSurge: z.int().min(0).max(10).default(1),
        maxUnavailable: z.int().min(0).max(10).default(0),
      })
      .default({ maxSurge: 1, maxUnavailable: 0 }),
    addons: z
      .object({
        cloudControllerManager: z.boolean().default(true),
        csiDriver: z.boolean().default(true),
      })
      .default({ cloudControllerManager: true, csiDriver: true }),
    sshPublicKeys: z
      .array(
        z
          .string()
          .regex(
            /^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+( .*)?$/,
            'An OpenSSH public key',
          ),
      )
      .max(20)
      .default([]),
    infrastructure: InfrastructureSchema,
  })
  .superRefine((spec, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });

    if (spec.kubernetes.flavor !== 'rke2') {
      issue(
        ['kubernetes', 'flavor'],
        'Only RKE2 is available yet (k0s from FP-9, kubeadm from FP-10)',
      );
    } else if (!/\+rke2r\d+$/.test(spec.kubernetes.version)) {
      issue(['kubernetes', 'version'], 'An RKE2 version like v1.35.9+rke2r1');
    }

    const { mode, controlPlane, workerPools } = spec.topology;
    if (mode === 'all-in-one') {
      if (controlPlane.replicas !== 1)
        issue(['topology', 'controlPlane', 'replicas'], 'All-in-one uses exactly one node');
      if (workerPools.length > 0)
        issue(['topology', 'workerPools'], 'All-in-one has no worker pools');
    } else if (workerPools.length === 0) {
      issue(['topology', 'workerPools'], 'Add at least one worker pool');
    }
    const seen = new Set<string>();
    workerPools.forEach((p, i) => {
      if (seen.has(p.name))
        issue(['topology', 'workerPools', i, 'name'], `Pool name "${p.name}" is used twice`);
      seen.add(p.name);
    });

    // Overlapping networks break routing inside the cluster (acceptance FP-5).
    const nodeCidr =
      spec.infrastructure.provider === 'openstack'
        ? {
            path: ['infrastructure', 'network', 'nodeCidr'],
            cidr: spec.infrastructure.network.nodeCidr,
            label: 'node network',
          }
        : {
            path: ['infrastructure', 'network', 'vpcCidr'],
            cidr: spec.infrastructure.network.vpcCidr,
            label: 'VPC',
          };
    const nets = [
      { path: ['kubernetes', 'podCidr'], cidr: spec.kubernetes.podCidr, label: 'pod network' },
      {
        path: ['kubernetes', 'serviceCidr'],
        cidr: spec.kubernetes.serviceCidr,
        label: 'service network',
      },
      nodeCidr,
    ];
    for (let i = 0; i < nets.length; i++) {
      for (let j = i + 1; j < nets.length; j++) {
        if (cidrsOverlap(nets[i]!.cidr, nets[j]!.cidr)) {
          issue(nets[j]!.path, `Overlaps with the ${nets[i]!.label} (${nets[i]!.cidr})`);
        }
      }
    }

    // Per-group image overrides must match the provider's ID format.
    const groups = [spec.topology.controlPlane, ...workerPools];
    const groupPath = (i: number, field: string) =>
      i === 0 ? ['topology', 'controlPlane', field] : ['topology', 'workerPools', i - 1, field];

    // FP5-F-19: root disk type.
    groups.forEach((g, i) => {
      if (!g.rootVolumeType) return;
      if (spec.infrastructure.provider === 'openstack' && !g.rootVolumeSizeGB) {
        issue(groupPath(i, 'rootVolumeType'), 'A volume type needs a root disk size');
      }
      if (
        spec.infrastructure.provider === 'aws' &&
        !(AWS_ROOT_VOLUME_TYPES as readonly string[]).includes(g.rootVolumeType)
      ) {
        issue(groupPath(i, 'rootVolumeType'), `One of ${AWS_ROOT_VOLUME_TYPES.join(', ')}`);
      }
    });

    groups.forEach((g, i) => {
      if (!g.image) return;
      const ok =
        spec.infrastructure.provider === 'openstack'
          ? z.uuid().safeParse(g.image).success
          : /^ami-[0-9a-f]{8,17}$/.test(g.image);
      if (!ok) {
        issue(
          i === 0
            ? ['topology', 'controlPlane', 'image']
            : ['topology', 'workerPools', i - 1, 'image'],
          spec.infrastructure.provider === 'openstack'
            ? 'An image ID (UUID)'
            : 'An AMI ID like ami-0123456789abcdef0',
        );
      }
    });

    // FP5-F-20: bastion host.
    const bastion = spec.infrastructure.bastion;
    if (bastion?.enabled) {
      const path = ['infrastructure', 'bastion'];
      if (!spec.infrastructure.sshKeyName) {
        issue(['infrastructure', 'sshKeyName'], 'The bastion needs an SSH key pair of the cloud');
      }
      if (spec.infrastructure.provider === 'openstack') {
        if (!bastion.machineSize) issue([...path, 'machineSize'], 'Required for the bastion');
        if (bastion.image && !z.uuid().safeParse(bastion.image).success) {
          issue([...path, 'image'], 'An image ID (UUID)');
        }
      } else {
        if (!bastion.allowedCidrs?.length) {
          issue([...path, 'allowedCidrs'], 'Add at least one network allowed to connect via SSH');
        }
        if (bastion.image && !/^ami-[0-9a-f]{8,17}$/.test(bastion.image)) {
          issue([...path, 'image'], 'An AMI ID like ami-0123456789abcdef0');
        }
      }
    }
    if (spec.infrastructure.provider === 'openstack' && bastion?.allowedCidrs?.length) {
      issue(
        ['infrastructure', 'bastion', 'allowedCidrs'],
        'OpenStack (CAPO) cannot restrict SSH to the bastion; remove the networks',
      );
    }

    if (
      spec.infrastructure.provider === 'openstack' &&
      !spec.infrastructure.apiServerLoadBalancer &&
      controlPlane.replicas > 1
    ) {
      issue(
        ['infrastructure', 'apiServerLoadBalancer'],
        'Several control plane nodes need the API load balancer',
      );
    }
  });

export type ClusterSpecInput = z.input<typeof ClusterSpecSchema>;
export type ClusterSpec = z.output<typeof ClusterSpecSchema>;

/** Annotation on the CAPI Cluster that stores the spec (FP5-F-07). */
export const CLUSTER_SPEC_ANNOTATION = 'capi-navigator.io/cluster-spec';
