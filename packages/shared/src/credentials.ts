import { z } from 'zod';

/** Infrastructure providers with stored credentials (FP-4). */
export const CREDENTIAL_PROVIDERS = ['openstack', 'aws', 'gcp', 'proxmox'] as const;
export const CredentialProviderSchema = z.enum(CREDENTIAL_PROVIDERS);
export type CredentialProvider = z.infer<typeof CredentialProviderSchema>;

export const CredentialNameSchema = z
  .string()
  .min(2, 'At least 2 characters')
  .max(40, 'At most 40 characters')
  .regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
    'Lowercase letters, digits and "-" only; must start and end with a letter or digit',
  );

const NamespaceNameSchema = z
  .string()
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'Must be a valid namespace name')
  .max(63);

/** Namespaces whose clusters may use the credential (ADR-0002). */
const AllowedNamespacesSchema = z
  .array(NamespaceNameSchema)
  .min(1, 'At least one namespace')
  .max(100)
  .default(['default']);

const PemSchema = z
  .string()
  .trim()
  .max(256 * 1024)
  .refine((v) => v === '' || /-----BEGIN CERTIFICATE-----/.test(v), {
    message: 'Must be a PEM certificate (-----BEGIN CERTIFICATE-----)',
  });

// ---- OpenStack (FP4-F-01..06) ----

export const OpenStackAuthSchema = z.discriminatedUnion('type', [
  /** Recommended (FP4-F-02). */
  z.object({
    type: z.literal('applicationCredential'),
    applicationCredentialId: z.string().trim().min(1, 'Required').max(256),
    applicationCredentialSecret: z.string().min(1, 'Required').max(1024),
  }),
  z.object({
    type: z.literal('password'),
    username: z.string().trim().min(1, 'Required').max(256),
    password: z.string().min(1, 'Required').max(1024),
    projectName: z.string().trim().min(1, 'Required').max(256),
    projectDomainName: z.string().trim().max(256).default('Default'),
    userDomainName: z.string().trim().max(256).default('Default'),
  }),
]);
export type OpenStackAuth = z.infer<typeof OpenStackAuthSchema>;

export const OpenStackCredentialInputSchema = z.discriminatedUnion('source', [
  /** Upload of a clouds.yaml, e.g. as downloaded from Horizon. */
  z.object({
    source: z.literal('clouds.yaml'),
    cloudsYaml: z
      .string()
      .min(1, 'Required')
      .max(256 * 1024),
    /** Entry to use; default: the only one in the file. */
    cloudName: z.string().max(253).optional(),
    cacert: PemSchema.optional(),
  }),
  z.object({
    source: z.literal('form'),
    authUrl: z.url({ protocol: /^https$/, message: 'Must be an https:// URL' }).max(2048),
    region: z.string().trim().min(1, 'Required').max(256),
    auth: OpenStackAuthSchema,
    cacert: PemSchema.optional(),
  }),
]);
export type OpenStackCredentialInput = z.input<typeof OpenStackCredentialInputSchema>;

// ---- AWS (FP4-F-07..10) ----

export const AwsRegionSchema = z
  .string()
  .regex(/^[a-z]{2}(-gov|-iso[a-z]*)?-[a-z]+-\d$/, 'An AWS region like eu-central-1');

export const AwsCredentialInputSchema = z.object({
  accessKeyId: z
    .string()
    .trim()
    .regex(/^(AKIA|ASIA)[A-Z0-9]{12,124}$/, 'An access key ID starts with AKIA (or ASIA)'),
  secretAccessKey: z.string().trim().min(16, 'Too short').max(1024),
  /** Only for temporary credentials (ASIA…). */
  sessionToken: z.string().trim().max(8192).optional(),
  /** Default region for tests and selection lists. */
  region: AwsRegionSchema,
});
export type AwsCredentialInput = z.input<typeof AwsCredentialInputSchema>;

// ---- Google Cloud (FP25-F-02..04) ----

export const GcpRegionSchema = z
  .string()
  .regex(/^[a-z]+-[a-z]+\d+$/, 'A Google Cloud region like europe-west6');

/** Service account key as downloaded from the Google Cloud console (JSON). */
export const GcpServiceAccountKeySchema = z
  .string()
  .trim()
  .min(1, 'Paste or upload the JSON key of the service account')
  .max(64 * 1024, 'At most 64 KiB');

export const GcpCredentialInputSchema = z.object({
  serviceAccountKey: GcpServiceAccountKeySchema,
  /** Default region for tests and selection lists. */
  region: GcpRegionSchema,
});
export type GcpCredentialInput = z.input<typeof GcpCredentialInputSchema>;

// ---- Proxmox VE (FP31-F-02..05) ----

/** A machine size of a Proxmox credential (FP31-F-04); its name is the cluster spec's machineSize. */
export const ProxmoxMachineSizeSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, 'Lowercase letters, digits, "-" and "."')
    .max(40),
  vcpus: z.int().min(1).max(128),
  memoryMiB: z
    .int()
    .min(1024)
    .max(1024 * 1024),
});
export type ProxmoxMachineSize = z.infer<typeof ProxmoxMachineSizeSchema>;

/**
 * Annotation on the ProxmoxCluster naming the stored credential; clusters reference a copy of
 * the Secret, which CAPMOX owns (FP31-F-09).
 */
export const PROXMOX_CREDENTIAL_ANNOTATION = 'capi-navigator.io/credential';

/** Sizes a new Proxmox credential starts with (FP31-F-04). */
export const DEFAULT_PROXMOX_MACHINE_SIZES: ProxmoxMachineSize[] = [
  { name: 'small', vcpus: 2, memoryMiB: 4096 },
  { name: 'medium', vcpus: 4, memoryMiB: 8192 },
  { name: 'large', vcpus: 8, memoryMiB: 16384 },
  { name: 'xlarge', vcpus: 8, memoryMiB: 32768 },
];

export const ProxmoxMachineSizesSchema = z
  .array(ProxmoxMachineSizeSchema)
  .min(1, 'At least one size')
  .max(20)
  .refine((l) => new Set(l.map((x) => x.name)).size === l.length, 'Size names must be unique');

export const ProxmoxCredentialInputSchema = z.object({
  /** API endpoint, e.g. https://pve.example.com:8006 (without /api2/json). */
  url: z
    .url({ protocol: /^https$/, message: 'An https:// URL like https://pve.example.com:8006' })
    .max(512)
    .transform((u) => u.replace(/\/+$/, '').replace(/\/api2\/json$/, '')),
  /** API token ID, user@realm!tokenname. */
  tokenId: z
    .string()
    .trim()
    .regex(/^[^@!\s]+@[^@!\s]+![A-Za-z][A-Za-z0-9._-]*$/, 'A token ID like capmox@pve!capi'),
  tokenSecret: z.string().trim().min(1, 'Required').max(256),
  /** CA certificate of the Proxmox API (PEM), e.g. /etc/pve/pve-root-ca.pem; empty: trust store. */
  caCert: PemSchema.optional(),
  /** Unset: the defaults for a new credential, the stored sizes for an update. */
  machineSizes: ProxmoxMachineSizesSchema.optional(),
});
export type ProxmoxCredentialInput = z.input<typeof ProxmoxCredentialInputSchema>;

// ---- API ----

export const CreateCredentialRequestSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('openstack'),
    name: CredentialNameSchema,
    displayName: z.string().trim().max(80).optional(),
    allowedNamespaces: AllowedNamespacesSchema,
    openstack: OpenStackCredentialInputSchema,
  }),
  z.object({
    provider: z.literal('aws'),
    name: CredentialNameSchema,
    displayName: z.string().trim().max(80).optional(),
    allowedNamespaces: AllowedNamespacesSchema,
    aws: AwsCredentialInputSchema,
  }),
  z.object({
    provider: z.literal('gcp'),
    name: CredentialNameSchema,
    displayName: z.string().trim().max(80).optional(),
    allowedNamespaces: AllowedNamespacesSchema,
    gcp: GcpCredentialInputSchema,
  }),
  z.object({
    provider: z.literal('proxmox'),
    name: CredentialNameSchema,
    displayName: z.string().trim().max(80).optional(),
    allowedNamespaces: AllowedNamespacesSchema,
    proxmox: ProxmoxCredentialInputSchema,
  }),
]);
export type CreateCredentialRequest = z.input<typeof CreateCredentialRequestSchema>;

export const UpdateCredentialRequestSchema = z
  .object({
    displayName: z.string().trim().max(80).optional(),
    allowedNamespaces: AllowedNamespacesSchema.optional(),
    /** New secret values; omit to keep the stored ones. Must match the credential's provider. */
    openstack: OpenStackCredentialInputSchema.optional(),
    aws: AwsCredentialInputSchema.optional(),
    gcp: GcpCredentialInputSchema.optional(),
    proxmox: ProxmoxCredentialInputSchema.optional(),
    /** Only the machine sizes (FP31-F-04), keeping the stored token. */
    machineSizes: ProxmoxMachineSizesSchema.optional(),
  })
  .refine(
    (v) =>
      v.displayName !== undefined ||
      v.allowedNamespaces !== undefined ||
      v.openstack !== undefined ||
      v.aws !== undefined ||
      v.gcp !== undefined ||
      v.proxmox !== undefined ||
      v.machineSizes !== undefined,
    { message: 'Nothing to update' },
  );
export type UpdateCredentialRequest = z.input<typeof UpdateCredentialRequestSchema>;

/** Request to list the clouds of a clouds.yaml before saving (no secrets returned). */
export const CloudsYamlInfoRequestSchema = z.object({
  cloudsYaml: z
    .string()
    .min(1)
    .max(256 * 1024),
});
export const CloudsYamlInfoSchema = z.object({
  clouds: z.array(
    z.object({
      name: z.string(),
      authUrl: z.string().optional(),
      region: z.string().optional(),
      authType: z.string().optional(),
    }),
  ),
});
export type CloudsYamlInfo = z.infer<typeof CloudsYamlInfoSchema>;

export const CredentialCheckSchema = z.object({
  /** Stable identifier for checks other parts of the app react to. */
  id: z.string().optional(),
  name: z.string(),
  ok: z.boolean(),
  /** A failed warning does not fail the test; it limits single features. */
  warning: z.boolean().optional(),
  message: z.string().optional(),
});

/** OpenStack: Neutron returns paging links that miss the endpoint path (e.g. Infomaniak). */
export const CHECK_NEUTRON_PAGING = 'neutron-paging-links';

/** Result of a credential test (FP4-F-04, FP4-F-09). Never contains secrets. */
export const CredentialTestResultSchema = z.object({
  ok: z.boolean(),
  testedAt: z.string(),
  /** Who the credentials belong to: OpenStack project, AWS account and ARN. */
  identity: z.string().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
  details: z.string().optional(),
  checks: z.array(CredentialCheckSchema),
  /** Command that fixes missing prerequisites, e.g. clusterawsadm (FP4-F-09). */
  fixCommand: z.string().optional(),
});
export type CredentialTestResult = z.infer<typeof CredentialTestResultSchema>;

/** Non-secret facts about a stored credential, for display. */
export const CredentialSummarySchema = z.object({
  authUrl: z.string().optional(),
  region: z.string().optional(),
  cloudName: z.string().optional(),
  authType: z.string().optional(),
  projectName: z.string().optional(),
  /** Last 4 characters of the AWS access key ID. */
  accessKeyIdSuffix: z.string().optional(),
  /** Google Cloud project and service account of the key (FP25-F-02). */
  projectId: z.string().optional(),
  serviceAccount: z.string().optional(),
  hasCaCert: z.boolean().optional(),
  /** Proxmox VE: API URL, token ID and the machine sizes offered in the wizard (FP31-F-02, F-04). */
  url: z.string().optional(),
  tokenId: z.string().optional(),
  machineSizes: z.array(ProxmoxMachineSizeSchema).optional(),
});
export type CredentialSummary = z.infer<typeof CredentialSummarySchema>;

/** A stored credential as returned by the API (FP4-F-06: never secret values). */
export const CredentialSchema = z.object({
  name: z.string(),
  provider: CredentialProviderSchema,
  displayName: z.string().optional(),
  allowedNamespaces: z.array(z.string()),
  summary: CredentialSummarySchema,
  /** The cluster-scoped identity clusters reference (ADR-0002). */
  identity: z.object({ apiVersion: z.string(), kind: z.string(), name: z.string() }),
  secret: z.object({ name: z.string(), namespace: z.string() }),
  createdAt: z.string().optional(),
  lastTest: CredentialTestResultSchema.optional(),
});
export type Credential = z.infer<typeof CredentialSchema>;
export const CredentialListSchema = z.array(CredentialSchema);

/** Selection lists for the cluster wizard (FP4-F-05, FP4-F-10). */
export const LOOKUP_KINDS = {
  openstack: [
    'images',
    'flavors',
    'externalNetworks',
    'availabilityZones',
    'keyPairs',
    'volumeTypes',
  ],
  aws: ['regions', 'availabilityZones', 'instanceTypes', 'images', 'keyPairs'],
  gcp: ['regions', 'zones', 'machineTypes', 'images', 'networks'],
  proxmox: ['nodes', 'templates', 'bridges', 'storages', 'machineSizes'],
} as const;
export type LookupKind = (typeof LOOKUP_KINDS)[keyof typeof LOOKUP_KINDS][number];

export const LookupOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  /** Extra facts shown in the dropdown, e.g. vCPUs and RAM of a flavor. */
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type LookupOption = z.infer<typeof LookupOptionSchema>;
export const LookupResponseSchema = z.object({
  kind: z.string(),
  region: z.string().optional(),
  options: z.array(LookupOptionSchema),
});
export type LookupResponse = z.infer<typeof LookupResponseSchema>;

// ---- verified provider facts (2026-10-17) ----

/** CAPO v0.15.0: cluster-scoped identity (api/v1alpha1/openstackclusteridentity_types.go). */
export const OPENSTACK_IDENTITY = {
  apiVersion: 'infrastructure.cluster.x-k8s.io/v1alpha1',
  kind: 'OpenStackClusterIdentity',
  group: 'infrastructure.cluster.x-k8s.io',
  version: 'v1alpha1',
  plural: 'openstackclusteridentities',
};

/** CAPA v2.13.1: api/v1beta2/awsidentity_types.go; Secret in the CAPA controller namespace. */
export const AWS_IDENTITY = {
  apiVersion: 'infrastructure.cluster.x-k8s.io/v1beta2',
  kind: 'AWSClusterStaticIdentity',
  group: 'infrastructure.cluster.x-k8s.io',
  version: 'v1beta2',
  plural: 'awsclusterstaticidentities',
};

/** IAM resources created by `clusterawsadm bootstrap iam create-cloudformation-stack` (v2.13.1). */
export const CAPA_IAM = {
  suffix: '.cluster-api-provider-aws.sigs.k8s.io',
  roles: ['control-plane', 'controllers', 'nodes'],
  instanceProfiles: ['control-plane', 'controllers', 'nodes'],
  stackName: 'cluster-api-provider-aws-sigs-k8s-io',
  fixCommand: 'clusterawsadm bootstrap iam create-cloudformation-stack --region <region>',
  docsUrl:
    'https://cluster-api-aws.sigs.k8s.io/topics/using-clusterawsadm-to-fulfill-prerequisites',
};

/** Publisher accounts of official AMIs: Canonical (Ubuntu), Debian cloud team, Rocky (RESF). */
export const CANONICAL_AWS_OWNER = '099720109477';
export const DEBIAN_AWS_OWNER = '136693071363';
export const ROCKY_AWS_OWNER = '792107900819';

/**
 * Public image families on Google Cloud offered in the wizard (FP25-F-04); the lookup resolves
 * each to its current image and leaves out families the project cannot see.
 */
export const GCP_IMAGE_FAMILIES = [
  { project: 'ubuntu-os-cloud', family: 'ubuntu-2404-lts-amd64', label: 'Ubuntu 24.04 LTS' },
  { project: 'ubuntu-os-cloud', family: 'ubuntu-2204-lts', label: 'Ubuntu 22.04 LTS' },
  { project: 'debian-cloud', family: 'debian-13', label: 'Debian 13' },
  { project: 'debian-cloud', family: 'debian-12', label: 'Debian 12' },
  { project: 'rocky-linux-cloud', family: 'rocky-linux-9', label: 'Rocky Linux 9' },
] as const;

/**
 * Permissions CAPG needs in the project (FP25-F-03), checked with testIamPermissions: networks,
 * firewalls, the API load balancer and instances; the role "Editor" covers them.
 */
export const GCP_REQUIRED_PERMISSIONS = [
  'compute.networks.create',
  'compute.subnetworks.create',
  'compute.routers.create',
  'compute.firewalls.create',
  'compute.addresses.create',
  'compute.healthChecks.create',
  'compute.backendServices.create',
  'compute.forwardingRules.create',
  'compute.targetTcpProxies.create',
  'compute.instanceGroups.create',
  'compute.instances.create',
  'compute.disks.create',
  'iam.serviceAccounts.actAs',
] as const;

/**
 * Proxmox VE privileges the token needs (FP31-F-03): CAPMOX clones and configures VMs, uploads the
 * cloud-init ISO and reads the guest agent; the CSI plugin allocates disks; the CCM reads VMs.
 * Alternatives: Proxmox VE 9 split VM.Monitor into VM.GuestAgent.*.
 */
export const PROXMOX_REQUIRED_PRIVILEGES: {
  privilege: string;
  alternatives?: string[];
  for: string;
}[] = [
  { privilege: 'VM.Allocate', for: 'CAPMOX' },
  { privilege: 'VM.Clone', for: 'CAPMOX' },
  { privilege: 'VM.Config.CDROM', for: 'CAPMOX' },
  { privilege: 'VM.Config.CPU', for: 'CAPMOX' },
  { privilege: 'VM.Config.Cloudinit', for: 'CAPMOX' },
  { privilege: 'VM.Config.Disk', for: 'CAPMOX, CSI' },
  { privilege: 'VM.Config.HWType', for: 'CAPMOX' },
  { privilege: 'VM.Config.Memory', for: 'CAPMOX' },
  { privilege: 'VM.Config.Network', for: 'CAPMOX' },
  { privilege: 'VM.Config.Options', for: 'CAPMOX' },
  { privilege: 'VM.PowerMgmt', for: 'CAPMOX' },
  { privilege: 'VM.Audit', for: 'CAPMOX, CCM, CSI' },
  { privilege: 'VM.GuestAgent.Audit', alternatives: ['VM.Monitor'], for: 'CAPMOX' },
  { privilege: 'Datastore.Allocate', for: 'CSI' },
  { privilege: 'Datastore.AllocateSpace', for: 'CAPMOX, CSI' },
  { privilege: 'Datastore.AllocateTemplate', for: 'CAPMOX (cloud-init ISO)' },
  { privilege: 'Datastore.Audit', for: 'CAPMOX, CSI' },
  { privilege: 'Sys.Audit', for: 'CAPMOX, CCM' },
  { privilege: 'SDN.Use', for: 'CAPMOX (bridge)' },
];
