import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Cluster lifecycle UI and roles (FP-6). Needs an active admin account of the running app and an
// active management cluster connection:
//   E2E_ADMIN_PASSWORD=... pnpm test:e2e
// The cluster status is served from a fixture, so no workload cluster is needed.
const adminUser = process.env.E2E_ADMIN_USER ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const CSRF = { 'x-capi-navigator': '1' };

const fixture = {
  summary: {
    name: 'demo',
    namespace: 'team-a',
    provider: 'openstack',
    flavor: 'rke2',
    version: 'v1.35.9+rke2r1',
    phase: 'Provisioned',
    ready: true,
    controlPlane: { replicas: 1, ready: 1 },
    workers: { replicas: 2, ready: 2 },
    labels: { env: 'e2e' },
    managed: true,
  },
  conditions: [],
  infrastructure: { kind: 'OpenStackCluster', name: 'demo', ready: true, conditions: [] },
  controlPlane: {
    kind: 'RKE2ControlPlane',
    name: 'demo-control-plane',
    replicas: 1,
    ready: 1,
    conditions: [],
  },
  machineDeployments: [
    { name: 'demo-default', pool: 'default', replicas: 2, ready: 2, upToDate: 2, conditions: [] },
  ],
  machines: [
    {
      name: 'demo-cp-1',
      role: 'control-plane',
      phase: 'Running',
      nodeName: 'demo-cp-1',
      conditions: [],
    },
  ],
  events: [],
  kubeconfigAvailable: true,
};

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

const dashboard = {
  generatedAt: new Date().toISOString(),
  kubernetesVersion: 'v1.37.1+rke2r1',
  metricsAvailable: true,
  totals: {
    nodes: 1,
    readyNodes: 1,
    namespaces: 4,
    pods: 3,
    podPhases: { Running: 3 },
    services: { ClusterIP: 2 },
  },
  nodes: [
    {
      name: 'demo-cp-1',
      ready: true,
      roles: ['control-plane'],
      cpu: { capacity: 2000, allocatable: 2000, requests: 500, limits: 100, usage: 150 },
      memory: { capacity: 4e9, allocatable: 4e9, requests: 1e9, limits: 2e8, usage: 2e9 },
      pods: { count: 3, capacity: 110 },
      unschedulable: false,
    },
  ],
  workloads: [
    { kind: 'Deployment', namespace: 'shop', name: 'web', desired: 1, ready: 1, status: 'ok' },
  ],
  problemPods: [],
  services: [],
  ingresses: [],
  events: [],
  warnings: [],
};

async function openFixture(page: Page): Promise<void> {
  // FP-18: read-only dashboard from a fixture as well.
  await page.route('**/clusters/team-a/demo/dashboard/events', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `event: state\ndata: ${JSON.stringify({ type: 'state', state: dashboard })}\n\n`,
    }),
  );
  await page.route('**/clusters/team-a/demo/events', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `event: state\ndata: ${JSON.stringify({ type: 'state', state: fixture })}\n\n`,
    }),
  );
  await page.goto('/clusters/team-a/demo');
  await expect(page.getByTestId('cluster-phase')).toBeVisible();
}

/** Creates an active viewer through the API (admin creates, viewer sets a new password). */
async function createViewer(request: APIRequestContext, name: string): Promise<string> {
  await request.post('/api/auth/login', {
    headers: CSRF,
    data: { username: adminUser, password: adminPassword },
  });
  await request.post('/api/users', {
    headers: CSRF,
    data: { username: name, role: 'viewer', password: 'E2e-Temp-Password-1' },
  });
  await request.post('/api/auth/logout', { headers: CSRF });
  await request.post('/api/auth/login', {
    headers: CSRF,
    data: { username: name, password: 'E2e-Temp-Password-1' },
  });
  await request.post('/api/auth/change-password', {
    headers: CSRF,
    data: { currentPassword: 'E2e-Temp-Password-1', newPassword: 'E2e-New-Password-1' },
  });
  await request.post('/api/auth/logout', { headers: CSRF });
  return 'E2e-New-Password-1';
}

test.describe('cluster lifecycle and roles (FP-6, FP-7)', () => {
  test.skip(!adminPassword, 'set E2E_ADMIN_PASSWORD to run');

  test('operators see lifecycle actions, viewers do not (acceptance FP-6)', async ({
    page,
    browser,
    request,
  }) => {
    await signIn(page, adminUser, adminPassword!);
    await openFixture(page);
    for (const id of ['delete-cluster', 'edit-labels', 'show-kubeconfig', 'scale-default']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await page.getByTestId('tab-tree').click();
    await expect(page.getByTestId('resource-tree')).toContainText('demo-control-plane');
    // FP-17: node shell for operators and admins.
    await page.getByRole('tab', { name: /Machines/ }).click();
    await expect(page.getByTestId('shell-demo-cp-1')).toBeVisible();
    // FP-7: day-2 configuration for operators and admins.
    await expect(page.getByTestId('tab-config')).toBeVisible();

    const viewer = `e2e-v-${Date.now().toString(36)}`;
    const password = await createViewer(request, viewer);
    const context = await browser.newContext();
    const viewerPage = await context.newPage();
    try {
      await signIn(viewerPage, viewer, password);
      await openFixture(viewerPage);
      for (const id of ['delete-cluster', 'edit-labels', 'show-kubeconfig', 'scale-default']) {
        await expect(viewerPage.getByTestId(id)).toHaveCount(0);
      }
      await viewerPage.getByRole('tab', { name: /Machines/ }).click();
      await expect(viewerPage.getByTestId('shell-demo-cp-1')).toHaveCount(0);
      // FP-18: viewers may read the dashboard.
      await viewerPage.getByTestId('tab-dashboard').click();
      await expect(viewerPage.getByTestId('dash-node-demo-cp-1')).toBeVisible();
      await expect(viewerPage.getByTestId('dash-workloads')).toContainText('shop/web');
      // FP-7: viewers read the YAML but get no day-2 forms.
      await expect(viewerPage.getByTestId('tab-config')).toHaveCount(0);
      await viewerPage.route('**/resources/yaml/events?*', (route) =>
        route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: `event: state\ndata: ${JSON.stringify({
            type: 'state',
            state: { yaml: 'kind: Cluster\nmetadata:\n  name: demo\n', masked: false },
          })}\n\n`,
        }),
      );
      await viewerPage.getByTestId('tab-tree').click();
      await viewerPage.getByRole('button', { name: /^Cluster demo/ }).click();
      await viewerPage.getByTestId('yaml-Cluster-demo').click();
      await expect(viewerPage.getByTestId('yaml-dialog')).toContainText('kind: Cluster');
      // The backend enforces the roles as well (hard rule 9).
      const api = viewerPage.request;
      const base = '/api/connections/home/clusters/team-a/demo';
      expect((await api.get(`${base}/kubeconfig`)).status()).toBe(403);
      expect((await api.get(`${base}/delete-preview`)).status()).toBe(403);
      expect(
        (
          await api.post(`${base}/scale/preview`, {
            headers: CSRF,
            data: { pool: 'default', replicas: 3 },
          })
        ).status(),
      ).toBe(403);
    } finally {
      await context.close();
      await request.post('/api/auth/login', {
        headers: CSRF,
        data: { username: adminUser, password: adminPassword },
      });
      await request.delete(`/api/users/${viewer}`, { headers: CSRF });
    }
  });
});
