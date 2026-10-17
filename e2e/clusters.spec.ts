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
  machines: [{ name: 'demo-cp-1', role: 'control-plane', phase: 'Running', conditions: [] }],
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

async function openFixture(page: Page): Promise<void> {
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

test.describe('cluster lifecycle and roles (FP-6)', () => {
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
