import { expect, test, type Page } from '@playwright/test';

// Screenshots for docs/ui-tour.md: `pnpm docs:screenshots` against the running app.
// Read-only: it opens pages and dialogs but never applies anything.
//   E2E_ADMIN_PASSWORD=... TOUR_OPENSTACK=<cluster> TOUR_AWS=<cluster> pnpm docs:screenshots
// Names of real users, credentials and accounts are replaced in the page before each screenshot.
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const openstackCluster = process.env.TOUR_OPENSTACK ?? 'infomaniak-demo-1';
const awsCluster = process.env.TOUR_AWS ?? 'aws-demo-1';
const namespace = process.env.TOUR_NAMESPACE ?? 'default';
const OUT = 'docs/images/ui-tour';

/** Text replaced before each screenshot: real names → neutral demo names. */
const REPLACE: [RegExp, string][] = [
  ...(process.env.TOUR_REPLACE ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => {
      const [from, to] = pair.split('=');
      return [new RegExp(from!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), to!] as [
        RegExp,
        string,
      ];
    }),
  [/\b\d{12}\b/g, '123456789012'], // AWS account IDs
  [/\.\.\.[A-Z0-9]{4}\b/g, '...ABCD'], // end of an access key
  // Public IPv4 addresses (bastion, floating IPs) → documentation range; private addresses,
  // 0.0.0.0 and public DNS resolvers stay.
  [
    /\b(?!0\.|10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|1\.1\.1\.1\b|8\.8\.[48]\.[48]\b|9\.9\.9\.9\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.(\d{1,3})\b/g,
    '203.0.113.$1',
  ],
  // Private IPv4 addresses: last octet blacked out; networks (10.0.0.0/16) stay.
  [
    /\b((?:10|127)\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}\b(?!\/)/g,
    '$1.███',
  ],
  [/\bip-(\d{1,3}-\d{1,3}-\d{1,3})-\d{1,3}\b/g, 'ip-$1-███'], // AWS node names
];

async function mask(page: Page): Promise<void> {
  await page.evaluate(
    (rules) => {
      const regexps = rules.map(([source, flags, to]) => [new RegExp(source, flags), to] as const);
      const replace = (text: string) => regexps.reduce((t, [re, to]) => t.replace(re, to), text);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const next = replace(node.nodeValue ?? '');
        if (next !== node.nodeValue) node.nodeValue = next;
      }
      for (const input of document.querySelectorAll('input')) {
        const next = replace(input.value);
        if (next !== input.value) input.value = next;
      }
    },
    REPLACE.map(([re, to]) => [re.source, re.flags, to] as [string, string, string]),
  );
}

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(800); // animations and live updates settle
  await mask(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
}

/** Opens a Vuetify select or autocomplete and picks the first option (or the one matching). */
async function pick(page: Page, field: ReturnType<Page['getByTestId']>, option?: RegExp) {
  await field.click();
  const list = page.locator('.v-overlay--active .v-list-item');
  await expect(list.first()).toBeVisible({ timeout: 60_000 });
  await (option ? list.filter({ hasText: option }).first() : list.first()).click();
}

async function tab(page: Page, id: string): Promise<void> {
  await page.getByTestId(`tab-${id}`).click();
}

test.describe.configure({ mode: 'serial' });

test.describe('UI tour screenshots', () => {
  test.skip(!adminPassword, 'set E2E_ADMIN_PASSWORD to run');

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill(process.env.E2E_ADMIN_USER ?? 'admin');
    await page.getByLabel('Password', { exact: true }).fill(adminPassword!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('pages', async ({ page }) => {
    await page.goto('/login');
    await page.goto('/');
    await expect(page.getByTestId('overview')).toBeVisible();
    await shot(page, '01-home', true);

    await page.goto('/clusters');
    await expect(page.getByText(openstackCluster)).toBeVisible();
    await shot(page, '02-clusters');

    await page.goto('/connections');
    await shot(page, '03-connections');

    await page.goto('/providers');
    await expect(page.getByTestId('providers-table')).toBeVisible();
    await shot(page, '04-providers');

    await page.goto('/credentials');
    await shot(page, '05-credentials');

    await page.goto('/helm-repositories');
    await shot(page, '06-helm-repositories');
  });

  test('cluster', async ({ page }) => {
    await page.goto(`/clusters/${namespace}/${openstackCluster}`);
    await expect(page.getByTestId('cluster-phase')).toBeVisible();
    await shot(page, '10-cluster-overview');

    await tab(page, 'tree');
    await expect(page.getByTestId('resource-tree')).toBeVisible();
    await shot(page, '11-resource-tree');

    await page.getByRole('tab', { name: /Machines/ }).click();
    await shot(page, '12-machines');

    await tab(page, 'dashboard');
    await expect(page.getByTestId('cluster-dashboard')).toBeVisible();
    await page.waitForTimeout(3000);
    await shot(page, '13-dashboard', true);

    await page.getByRole('tab', { name: /Machines/ }).click();
    await page.locator('[data-testid^="shell-"]').first().click();
    await expect(page.getByTestId('shell-state')).toHaveText('connected', { timeout: 120_000 });
    await page.locator('.xterm').click();
    await page.keyboard.type(
      'grep PRETTY_NAME /etc/os-release; uptime; free -h | head -2; ' +
        "ps -eo comm | grep -xE 'kubelet|containerd|etcd|kube-apiserver' | sort -u\n",
    );
    await page.waitForTimeout(3000);
    await shot(page, '14-node-shell');
    await page.getByTestId('shell-close').click();

    await tab(page, 'config');
    await expect(page.getByTestId('cluster-configuration')).toBeVisible();
    await shot(page, '15-configuration');

    await tab(page, 'addons');
    await shot(page, '17-cluster-addons');

    await tab(page, 'events');
    await shot(page, '18-events');

    await page.goto(`/clusters/${namespace}/${awsCluster}`);
    await expect(page.getByTestId('cluster-phase')).toBeVisible();
    await shot(page, '19-cluster-aws');
  });

  test('change preview', async ({ page }) => {
    // Opens the scale dialog and its preview (dry run); nothing is applied.
    await page.goto(`/clusters/${namespace}/${openstackCluster}`);
    await tab(page, 'config');
    await page.locator('[data-testid^="day2-scale-"]').first().click();
    const dialog = page.getByTestId('change-dialog');
    await dialog.getByLabel(/Replicas|Nodes/).fill('3');
    await dialog.getByTestId('change-preview').click();
    await expect(dialog.getByText(/change|object/i).first()).toBeVisible({ timeout: 60_000 });
    await shot(page, '16-change-preview');
  });

  test('wizard', async ({ page }) => {
    // Fills the wizard up to the YAML preview; "Create" is never clicked.
    await page.goto('/clusters/new');
    await page.getByTestId('name').locator('input:not([type=hidden])').fill('demo-openstack');
    await page.getByTestId('provider-openstack').click();
    await pick(page, page.getByTestId('credential'), /Infomaniak|OpenStack/);
    await shot(page, '20-wizard-basics');
    await page.getByTestId('next').click();

    await pick(page, page.getByTestId('size-control-plane'), /a2-ram4/);
    await pick(page, page.getByTestId('size-worker'), /a2-ram4/);
    await shot(page, '21-wizard-topology');
    await page.getByTestId('next').click();

    await pick(page, page.getByTestId('image'), /Ubuntu 24/);
    await page.getByTestId('image').click(); // show the images looked up from the cloud
    await expect(page.locator('.v-overlay--active .v-list-item').first()).toBeVisible();
    await shot(page, '22-wizard-infrastructure');
    await page.keyboard.press('Escape');
    await page.getByTestId('next').click();

    await shot(page, '23-wizard-addons');
    await page.getByTestId('next').click();
    await page.getByTestId('next').click();
    await page.getByTestId('to-preview').click();
    await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 60_000 });
    await shot(page, '24-wizard-preview');
  });

  test('administration', async ({ page }) => {
    await page.goto('/addons');
    await shot(page, '30-addons');

    await page.goto('/roles');
    await expect(page.getByTestId('roles-table')).toBeVisible();
    await shot(page, '31-roles');
    await page.setViewportSize({ width: 1440, height: 1250 }); // the dialog is tall
    await page.getByTestId('role-add').click();
    await page
      .getByTestId('role-name')
      .locator('input:not([type=hidden])')
      .fill('cluster-operator');
    await page
      .getByTestId('role-display-name')
      .locator('input:not([type=hidden])')
      .fill('Cluster operator');
    for (const p of ['clusters.create', 'clusters.change', 'nodes.shell']) {
      await page.getByTestId(`permission-${p}`).click();
    }
    await shot(page, '32-role-editor');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto('/users');
    await expect(page.getByTestId('users-table')).toBeVisible();
    await shot(page, '33-users');
    const tokens = page.locator('[data-testid^="tokens-"]').first();
    if (await tokens.count()) {
      await tokens.click();
      await expect(page.getByTestId('tokens-dialog')).toBeVisible();
      await shot(page, '34-api-tokens');
      await page.keyboard.press('Escape');
    }

    await page.goto('/api/docs/');
    await expect(page.locator('.opblock-tag').first()).toBeVisible({ timeout: 30_000 });
    await shot(page, '35-swagger');
  });
});
