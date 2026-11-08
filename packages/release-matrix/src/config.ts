import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * Configuration of the release test matrix: everything that belongs to one environment (addresses,
 * images, credential names, registries). It stays out of Git (`*.local.yaml`); the repository is
 * public. See matrix.example.yaml.
 */

const Patch = z.record(z.string(), z.unknown());
const Flavor = z.enum(['rke2', 'k0s', 'kubeadm']);
export const PLATFORMS = ['aws', 'gcp', 'openstack', 'proxmox'] as const;
export type Platform = (typeof PLATFORMS)[number];

const PlatformSchema = z.object({
  /** `spec.infrastructure` shared by every case of the platform. */
  infrastructure: Patch,
  /** Image or template per distribution where it differs from `infrastructure.image`. */
  images: z.partialRecord(Flavor, z.string()).default({}),
  /** Machine sizes: all-in-one node, control plane, worker, worker of a hosted control plane host. */
  sizes: z.object({
    allInOne: z.string(),
    controlPlane: z.string(),
    worker: z.string(),
    hostWorker: z.string().optional(),
  }),
  /** Extra fields of every machine (e.g. rootVolumeSizeGB). */
  machine: Patch.default({}),
  /**
   * Patches of `spec.infrastructure`, one per case running at the same time (addresses, node
   * networks). Unset: cases only limited by `parallel`.
   */
  slots: z.array(Patch).default([]),
  /** Cases of this platform at the same time. */
  parallel: z.number().int().min(1).default(3),
  /** Hosted control planes (k0s): host and tenant patches; runs alone on the platform. */
  hcp: z.object({ host: Patch.default({}), tenant: Patch.default({}) }).optional(),
  /** Air-gapped variants of the cases; unset: none on this platform. */
  airGapped: z
    .object({
      /** `connection`: the internal registry of the app's connection; otherwise the registry. */
      registry: z.union([z.literal('connection'), Patch]).default('connection'),
      /** Patch of `spec.infrastructure` (e.g. gateway without internet, internal DNS). */
      infrastructure: Patch.default({}),
      images: z.partialRecord(Flavor, z.string()).default({}),
      /**
       * Proof: `blocked` – a pod must not reach the internet; `images` – write the images the
       * pods run, to compare with the registry's log.
       */
      proof: z.enum(['blocked', 'images']).default('blocked'),
      hcp: z.object({ host: Patch.default({}), tenant: Patch.default({}) }).optional(),
    })
    .optional(),
});
export type PlatformConfig = z.infer<typeof PlatformSchema>;

export const MatrixConfigSchema = z.object({
  app: z.object({
    url: z.string().default('http://localhost:3000'),
    connection: z.string(),
    namespace: z.string(),
    /** File with an API token of the app (FP-22); never in this file. */
    tokenFile: z.string().default('~/.config/capi-navigator/navigator-token'),
    /** Let the app create the credential Secret in the namespace when it is missing. */
    grantCredentialNamespace: z.boolean().default(true),
  }),
  /** Prefix of the cluster names; the names are `<prefix>-<platform>-<flavor>-<mode>[-ag]`. */
  prefix: z
    .string()
    .regex(/^[a-z][a-z0-9]{0,5}$/)
    .default('mt'),
  /** Markdown file the results are appended to. */
  protocol: z.string().default('release-matrix.local.md'),
  /** Minutes until a cluster must be Available. */
  availableMinutes: z.number().default(30),
  platforms: z.partialRecord(z.enum(PLATFORMS), PlatformSchema),
});
export type MatrixConfig = z.infer<typeof MatrixConfigSchema>;

export const expandHome = (path: string) => path.replace(/^~(?=$|\/)/, homedir());

export function loadConfig(path: string): MatrixConfig {
  return MatrixConfigSchema.parse(parse(readFileSync(expandHome(path), 'utf8')));
}
