import { z } from 'zod';

/** Infrastructure providers with stored credentials (FP-4). */
export const CREDENTIAL_PROVIDERS = ['openstack', 'aws'] as const;
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
]);
export type CreateCredentialRequest = z.input<typeof CreateCredentialRequestSchema>;

export const UpdateCredentialRequestSchema = z
  .object({
    displayName: z.string().trim().max(80).optional(),
    allowedNamespaces: AllowedNamespacesSchema.optional(),
    /** New secret values; omit to keep the stored ones. Must match the credential's provider. */
    openstack: OpenStackCredentialInputSchema.optional(),
    aws: AwsCredentialInputSchema.optional(),
  })
  .refine(
    (v) =>
      v.displayName !== undefined ||
      v.allowedNamespaces !== undefined ||
      v.openstack !== undefined ||
      v.aws !== undefined,
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
  name: z.string(),
  ok: z.boolean(),
  message: z.string().optional(),
});

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
  hasCaCert: z.boolean().optional(),
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
  openstack: ['images', 'flavors', 'externalNetworks', 'availabilityZones', 'keyPairs'],
  aws: ['regions', 'availabilityZones', 'instanceTypes', 'images', 'keyPairs'],
} as const;
export type LookupKind =
  (typeof LOOKUP_KINDS)['openstack'][number] | (typeof LOOKUP_KINDS)['aws'][number];

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
