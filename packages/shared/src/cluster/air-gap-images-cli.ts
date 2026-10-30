// Writes air-gap-images.generated.ts (FP29-F-17): the images of every RKE2, k0s and kubeadm version
// and of every add-on preset in versions.yaml. Run with `pnpm airgap:images` after a version change;
// needs the internet and helm. k0s and kubeadm binaries are cached in ~/.cache/capi-navigator.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSIONS } from '../versions.generated.js';
import { ADDON_PRESETS } from './addons.js';
import { imagesInManifests, normalizeImage } from './air-gap-images.js';

/** RKE2 publishes its image lists per release; the app uses Calico (serverConfig.cni). */
async function rke2Images(version: string): Promise<string[]> {
  const base = `https://github.com/rancher/rke2/releases/download/${encodeURIComponent(version)}`;
  const lists = await Promise.all(
    ['rke2-images-core', 'rke2-images-calico'].map(async (name) => {
      const res = await fetch(`${base}/${name}.linux-amd64.txt`);
      if (!res.ok) throw new Error(`${name} of ${version}: HTTP ${res.status}`);
      return (await res.text()).split('\n').filter((l) => l.trim());
    }),
  );
  return [...new Set(lists.flat().map((i) => normalizeImage(i.trim())))].sort();
}

/** k0s prints its images for a configuration; the app's: Calico, Konnectivity (k0s.ts). */
const K0S_CONFIG = `apiVersion: k0s.k0sproject.io/v1beta1
kind: ClusterConfig
metadata:
  name: k0s
spec:
  network:
    provider: calico
    calico:
      mode: vxlan
`;
async function k0sImages(version: string): Promise<string[]> {
  const dir = join(homedir(), '.cache', 'capi-navigator', 'k0s', version);
  const bin = join(dir, 'k0s');
  if (!existsSync(bin)) {
    mkdirSync(dir, { recursive: true });
    const v = encodeURIComponent(version);
    const res = await fetch(
      `https://github.com/k0sproject/k0s/releases/download/${v}/k0s-${v}-amd64`,
    );
    if (!res.ok) throw new Error(`k0s ${version}: HTTP ${res.status}`);
    writeFileSync(bin, Buffer.from(await res.arrayBuffer()));
    chmodSync(bin, 0o755);
  }
  const out = execFileSync(bin, ['airgap', 'list-images', '--config', '-'], {
    input: K0S_CONFIG,
    encoding: 'utf8',
  });
  return [
    ...new Set(
      out
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => normalizeImage(l.trim())),
    ),
  ].sort();
}

/**
 * kubeadm prints the images of a version (ADR-0032); the node name is set, since kubeadm validates
 * it and a build host's name may not be a valid one.
 */
async function kubeadmImages(version: string): Promise<string[]> {
  const dir = join(homedir(), '.cache', 'capi-navigator', 'kubeadm', version);
  const bin = join(dir, 'kubeadm');
  if (!existsSync(bin)) {
    mkdirSync(dir, { recursive: true });
    const url = `https://dl.k8s.io/release/${version}/bin/linux/amd64/kubeadm`;
    const [res, sum] = await Promise.all([fetch(url), fetch(`${url}.sha256`)]);
    if (!res.ok || !sum.ok) throw new Error(`kubeadm ${version}: HTTP ${res.status}/${sum.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    const expected = (await sum.text()).trim().split(/\s+/)[0];
    if (createHash('sha256').update(data).digest('hex') !== expected)
      throw new Error(`kubeadm ${version}: checksum mismatch`);
    writeFileSync(bin, data);
    chmodSync(bin, 0o755);
  }
  const config = [
    'apiVersion: kubeadm.k8s.io/v1beta4',
    'kind: InitConfiguration',
    'nodeRegistration:',
    '  name: image-list',
    '---',
    'apiVersion: kubeadm.k8s.io/v1beta4',
    'kind: ClusterConfiguration',
    `kubernetesVersion: ${version}`,
    '',
  ].join('\n');
  const file = join(dir, 'config.yaml');
  writeFileSync(file, config);
  const out = execFileSync(bin, ['config', 'images', 'list', '--config', file], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => normalizeImage(l.trim()));
}

/** Calico of kubeadm clusters comes as manifest shipped with the backend (ADR-0014). */
function calicoImages(): string[] {
  const manifest = new URL(
    `../../../../apps/backend/assets/calico/${VERSIONS.cni.calico.manifest}`,
    import.meta.url,
  );
  return imagesInManifests(readFileSync(manifest, 'utf8'));
}

/** Renders a preset's chart with its values; CAAPH's Go templates get placeholders. */
function presetImages(preset: (typeof ADDON_PRESETS)[number], work: string): string[] {
  const values = join(work, `${preset.id}.yaml`);
  writeFileSync(values, preset.valuesTemplate.replace(/\{\{[^}]*\}\}/g, 'placeholder'));
  const chart = preset.repoURL.startsWith('oci://')
    ? [`${preset.repoURL}/${preset.chartName}`]
    : [preset.chartName, '--repo', preset.repoURL];
  const out = execFileSync(
    'helm',
    ['template', preset.chartName, ...chart, '--version', preset.version, '-f', values],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return imagesInManifests(out);
}

const work = mkdtempSync(join(tmpdir(), 'air-gap-images-'));
try {
  const distributions: Record<string, Record<string, string[]>> = {
    rke2: {},
    k0s: {},
    kubeadm: {},
  };
  for (const { version } of VERSIONS.kubernetes.rke2.versions) {
    try {
      distributions.rke2![version] = await rke2Images(version);
      console.log(`rke2 ${version}: ${distributions.rke2![version]!.length} images`);
    } catch (err) {
      // A release without assets (seen with v1.33.13+rke2r3) cannot be installed at all.
      console.warn(`rke2 ${version} skipped, check the catalog: ${(err as Error).message}`);
    }
  }
  for (const { version } of VERSIONS.kubernetes.k0s.versions) {
    distributions.k0s![version] = await k0sImages(version);
    console.log(`k0s ${version}: ${distributions.k0s![version]!.length} images`);
  }
  const calico = calicoImages();
  for (const { version } of VERSIONS.kubernetes.kubeadm.versions) {
    distributions.kubeadm![version] = [
      ...new Set([...(await kubeadmImages(version)), ...calico]),
    ].sort();
    console.log(`kubeadm ${version}: ${distributions.kubeadm![version]!.length} images`);
  }
  const presets: Record<string, { version: string; images: string[] }> = {};
  for (const preset of ADDON_PRESETS) {
    presets[preset.id] = { version: preset.version, images: presetImages(preset, work) };
    console.log(`${preset.id} ${preset.version}: ${presets[preset.id]!.images.length} images`);
  }
  const target = new URL('../../src/cluster/air-gap-images.generated.ts', import.meta.url);
  writeFileSync(
    target,
    [
      '// Generated from versions.yaml by `pnpm airgap:images` (FP29-F-17). Do not edit.',
      `export const AIR_GAP_IMAGES = ${JSON.stringify({ distributions, presets }, null, 2)} as const;`,
      '',
    ].join('\n'),
  );
  console.log(`wrote ${target.pathname}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
