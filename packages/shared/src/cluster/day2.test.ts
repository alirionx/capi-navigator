/* eslint-disable @typescript-eslint/no-explicit-any -- manifests are read loosely in this test */
import { describe, expect, it } from 'vitest';
import { applySpecChange, SpecChangeError, upgradeProblem } from './changes.js';
import { ClusterSpecSchema, type ClusterSpec } from './spec.js';
import { transform } from './transform.js';

const spec: ClusterSpec = ClusterSpecSchema.parse({
  name: 'demo',
  namespace: 'team-a',
  kubernetes: { version: 'v1.34.12+rke2r1' },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 1, machineSize: 'a2-ram4-disk50-perf1' },
    workerPools: [{ name: 'default', replicas: 2, machineSize: 'a4-ram8-disk50-perf1' }],
  },
  infrastructure: {
    provider: 'openstack',
    credentialRef: 'infomaniak',
    image: '6f1b2a3c-0d4e-4f5a-8b6c-7d8e9fa0b1c2',
    externalNetwork: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  },
});
const now = new Date('2026-10-18T10:00:00Z');
const objs = (s: ClusterSpec) => transform(s, { credential: { cloudName: 'infomaniak' } });
const byKey = (s: ClusterSpec) =>
  new Map(objs(s).map((o) => [`${o.kind}/${o.metadata.name}`, JSON.stringify(o)]));
const get = (s: ClusterSpec, kind: string) =>
  objs(s).find((o) => o.kind === kind) as unknown as {
    metadata: { name: string };
    spec: Record<string, any>;
  };
const templateNames = (s: ClusterSpec) =>
  objs(s)
    .filter((o) => o.kind.endsWith('Template'))
    .map((o) => o.metadata.name)
    .sort();

/** Hard rule 5: every object of the old spec that keeps its name is unchanged, except Cluster/CP/MD. */
function expectNoTemplateEdited(before: ClusterSpec, after: ClusterSpec): void {
  const a = byKey(before);
  const b = byKey(after);
  for (const [key, json] of b) {
    if (key.includes('Template/') && a.has(key)) expect(json).toBe(a.get(key));
  }
}

describe('day-2 changes (FP-7)', () => {
  it('upgrades the control plane first and keeps workers on the old version (FP7-F-08)', () => {
    const up = applySpecChange(spec, { type: 'upgrade', version: 'v1.35.9+rke2r1' }, now);
    expect(up.kubernetes).toMatchObject({
      version: 'v1.35.9+rke2r1',
      workerVersion: 'v1.34.12+rke2r1',
    });
    expect(get(up, 'RKE2ControlPlane').spec.version).toBe('v1.35.9+rke2r1');
    expect(get(up, 'MachineDeployment').spec.template.spec.version).toBe('v1.34.12+rke2r1');
    expect(() => applySpecChange(up, { type: 'upgrade', version: 'v1.36.5+rke2r1' }, now)).toThrow(
      /still running/,
    );
  });

  it('rejects downgrades, minor jumps and other distributions in the form (acceptance)', () => {
    expect(upgradeProblem('v1.35.9+rke2r1', 'v1.34.12+rke2r1')).toMatch(/no downgrades/);
    expect(upgradeProblem('v1.35.9+rke2r1', 'v1.35.9+rke2r1')).toMatch(/no downgrades/);
    expect(upgradeProblem('v1.34.12+rke2r1', 'v1.36.5+rke2r1')).toMatch(/one minor/);
    expect(upgradeProblem('v1.35.8+k0s.1', 'v1.36.5+rke2r1')).toMatch(/distribution/);
    expect(upgradeProblem('v1.34.12+rke2r1', 'v1.35.9+rke2r1')).toBeUndefined();
    expect(upgradeProblem('v1.35.9+rke2r1', 'v1.35.9+rke2r2')).toBeUndefined();
  });

  it('changes flavor and image by template rotation only (FP7-F-07, FP7-F-10, hard rule 5)', () => {
    const flavor = applySpecChange(
      spec,
      { type: 'machine', group: 'default', machineSize: 'a8-ram16-disk50-perf1' },
      now,
    );
    expect(templateNames(flavor)).not.toEqual(templateNames(spec));
    expectNoTemplateEdited(spec, flavor);
    const image = applySpecChange(
      spec,
      { type: 'machine', group: 'control-plane', image: '11111111-2222-4333-8444-555555555555' },
      now,
    );
    expect(
      get(image, 'RKE2ControlPlane').spec.machineTemplate.spec.infrastructureRef.name,
    ).not.toBe(get(spec, 'RKE2ControlPlane').spec.machineTemplate.spec.infrastructureRef.name);
    expectNoTemplateEdited(spec, image);
  });

  it('rebuilds a pool via rollout.after and the control plane via a new template (FP7-F-11)', () => {
    const pool = applySpecChange(spec, { type: 'rebuild', group: 'default' }, now);
    expect(get(pool, 'MachineDeployment').spec.rollout.after).toBe('2026-10-18T10:00:00.000Z');
    expect(templateNames(pool)).toEqual(templateNames(spec));
    const cp = applySpecChange(spec, { type: 'rebuild', group: 'control-plane' }, now);
    expect(templateNames(cp)).not.toEqual(templateNames(spec));
    expectNoTemplateEdited(spec, cp);
  });

  it('edits node customization with new bootstrap templates (FP7-F-13)', () => {
    const custom = applySpecChange(
      spec,
      {
        type: 'customization',
        group: 'default',
        customization: {
          files: [{ path: '/etc/motd', content: 'hello\n', permissions: '0644' }],
          preCommands: [],
          postCommands: [],
        },
      },
      now,
    );
    expect(templateNames(custom)).not.toEqual(templateNames(spec));
    expectNoTemplateEdited(spec, custom);
  });

  it('scales the control plane and adds/removes pools (FP7-F-06)', () => {
    expect(
      applySpecChange(spec, { type: 'scaleControlPlane', replicas: 3 }, now).topology.controlPlane
        .replicas,
    ).toBe(3);
    const added = applySpecChange(
      spec,
      { type: 'addPool', pool: { name: 'gpu', replicas: 1, machineSize: 'a8-ram32-disk80-perf1' } },
      now,
    );
    expect(
      objs(added)
        .filter((o) => o.kind === 'MachineDeployment')
        .map((o) => o.metadata.name),
    ).toEqual(['demo-default', 'demo-gpu']);
    const removed = applySpecChange(added, { type: 'removePool', pool: 'default' }, now);
    expect(removed.topology.workerPools.map((p) => p.name)).toEqual(['gpu']);
    expect(() => applySpecChange(removed, { type: 'removePool', pool: 'gpu' }, now)).toThrow(
      SpecChangeError,
    );
    expect(() =>
      applySpecChange(
        spec,
        { type: 'addPool', pool: { name: 'default', replicas: 1, machineSize: 'x' } },
        now,
      ),
    ).toThrow(/already exists/);
  });

  it('sets rollout settings per pool (FP7-F-18)', () => {
    const s = applySpecChange(
      spec,
      { type: 'rolloutSettings', pool: 'default', settings: { maxSurge: 2, maxUnavailable: 1 } },
      now,
    );
    expect(get(s, 'MachineDeployment').spec.rollout.strategy.rollingUpdate).toEqual({
      maxSurge: 2,
      maxUnavailable: 1,
    });
  });
});
