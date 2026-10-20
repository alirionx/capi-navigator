import { z } from 'zod';

/** Where newer versions of an entry come from (FP20-F-01); also read by the update report. */
export const VersionSourceSchema = z.object({
  datasource: z.enum(['github-releases', 'helm', 'docker']),
  /** GitHub repository, chart name or image name. */
  package: z.string().min(1),
  /** Helm repository URL or container registry. */
  registry: z.string().min(1).optional(),
});
export type VersionSource = z.infer<typeof VersionSourceSchema>;

/** YAML turns `2026-10-17` into a date; keep it as the ISO day. */
const DaySchema = z
  .union([z.string(), z.date()])
  .transform((d) => (typeof d === 'string' ? d : d.toISOString().slice(0, 10)))
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'));

const VersionString = z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1));

const EntrySchema = z.object({
  version: VersionString,
  source: VersionSourceSchema,
  verified: DaySchema,
  note: z.string().optional(),
});

/** An upstream manifest shipped with the backend (apps/backend/assets), verified by checksum. */
const ManifestEntrySchema = EntrySchema.extend({
  manifest: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const KubernetesVersionSchema = z.object({
  version: z.string().regex(/^v\d+\.\d+\.\d+/, 'Expected a "v1.2.3…" version'),
  verifiedWithProvider: z.string(),
  default: z.boolean().optional(),
  untested: z.boolean().optional(),
});

const KubernetesCatalogSchema = z.object({
  source: VersionSourceSchema,
  verified: DaySchema,
  note: z.string().optional(),
  versions: z.array(KubernetesVersionSchema).min(1),
});

/** The structure of versions.yaml (FP20-F-01, FP20-F-02, ADR-0018). */
export const VersionsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  providers: z.strictObject({
    'cluster-api': EntrySchema,
    rke2: EntrySchema,
    k0smotron: EntrySchema,
    openstack: EntrySchema,
    aws: EntrySchema,
    gcp: EntrySchema,
    helm: EntrySchema,
  }),
  prerequisites: z.strictObject({
    'cert-manager': EntrySchema,
    'capi-operator': EntrySchema,
    orc: z.object({
      source: VersionSourceSchema,
      verified: DaySchema,
      note: z.string().optional(),
      byCapoMinor: z.record(z.string().regex(/^v\d+\.\d+$/), z.string()),
    }),
  }),
  kubernetes: z.strictObject({
    rke2: KubernetesCatalogSchema,
    k0s: KubernetesCatalogSchema,
    kubeadm: KubernetesCatalogSchema,
  }),
  addonPresets: z.strictObject({
    'openstack-ccm': EntrySchema,
    'openstack-csi': EntrySchema,
    'aws-ccm': EntrySchema,
    'aws-csi': EntrySchema,
    kured: EntrySchema,
  }),
  kubeadmRuntime: z.strictObject({ containerd: EntrySchema, runc: EntrySchema }),
  cni: z.strictObject({ calico: ManifestEntrySchema }),
  /** Add-on manifests without a Helm chart, delivered by a ClusterResourceSet (FP25-F-08). */
  addonManifests: z.strictObject({
    'gcp-ccm': ManifestEntrySchema,
    'gcp-csi': ManifestEntrySchema,
  }),
  images: z.strictObject({ 'node-shell': EntrySchema }),
  /** Tools of the local test setup, not part of the app (e.g. Dex for FP-14). */
  testTools: z.strictObject({ dex: EntrySchema, socat: EntrySchema }),
});
export type VersionsFile = z.output<typeof VersionsFileSchema>;
