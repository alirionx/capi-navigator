import { describe, expect, it } from 'vitest';
import { ClusterSpecSchema, INFRA_PLUGINS } from '@capi-navigator/shared';
import { stepIssues, visibleIssues } from './wizard-issues.js';

const empty = {
  name: '',
  namespace: 'default',
  kubernetes: { version: 'v1.35.9+rke2r1' },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 1, machineSize: 'a2-ram4-disk50' },
    workerPools: [{ name: 'default', replicas: 1, machineSize: 'a2-ram4-disk50' }],
  },
  infrastructure: {
    provider: 'openstack',
    credentialRef: 'infomaniak',
    image: '6f1b2a3c-0d4e-4f5a-8b6c-7d8e9fa0b1c2',
    externalNetwork: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  },
};

describe('cluster wizard issues (FP5-F-02)', () => {
  const r = ClusterSpecSchema.safeParse(empty);
  const issues = r.success ? [] : stepIssues(r.error.issues);

  it('reports one issue per field with its label', () => {
    expect(r.success).toBe(false);
    expect(issues.filter((i) => i.path === 'name')).toEqual([
      { path: 'name', message: expect.any(String), step: 1, labelKey: 'wizard.name' },
    ]);
  });

  it('shows nothing when the wizard opens, and the issues once the step was left', () => {
    expect(visibleIssues(issues, 1, new Set())).toEqual([]);
    expect(visibleIssues(issues, 1, new Set([1])).map((i) => i.path)).toEqual(['name']);
    expect(visibleIssues(issues, 2, new Set([1]))).toEqual([]);
  });

  it('assigns paths to their steps and keeps unknown fields without label', () => {
    const mapped = stepIssues([
      { path: ['topology', 'workerPools', 0, 'name'], message: 'Required' },
      { path: ['infrastructure', 'image'], message: 'Required' },
      { path: ['addons', 'helm', 0], message: 'Bad' },
    ]);
    expect(mapped).toEqual([
      {
        path: 'topology.workerPools.0.name',
        message: 'Required',
        step: 2,
        labelKey: 'wizard.poolName',
      },
      { path: 'infrastructure.image', message: 'Required', step: 3, labelKey: 'wizard.image' },
      { path: 'addons.helm.0', message: 'Bad', step: 4 },
    ]);
  });

  it('takes the labels of infrastructure fields from the provider form (FP25-F-05)', () => {
    const issue = { path: ['infrastructure', 'image'], message: 'Required' };
    expect(stepIssues([issue], INFRA_PLUGINS.aws.form)[0]?.labelKey).toBe('wizard.ami');
    expect(stepIssues([issue], INFRA_PLUGINS.openstack.form)[0]?.labelKey).toBe('wizard.image');
  });
});
