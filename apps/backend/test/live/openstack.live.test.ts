// Opt-in, read-only test against a real OpenStack cloud (FP-4 acceptance, Infomaniak).
// Runs only with OPENSTACK_CLOUDS_YAML=<path to clouds.yaml>; prints no secrets.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OpenStackCredentialPlugin } from '../../src/infra-providers/openstack/openstack-credential.plugin.js';

const path = process.env.OPENSTACK_CLOUDS_YAML;

describe.skipIf(!path)('OpenStack credentials against a real cloud (read-only)', () => {
  const plugin = new OpenStackCredentialPlugin();

  it('normalizes, tests and lists images, flavors and external networks', async () => {
    const { data, summary } = plugin.normalize({
      source: 'clouds.yaml',
      cloudsYaml: readFileSync(path!, 'utf8'),
    });
    console.log('summary', summary);
    const result = await plugin.test(data);
    console.log('test', result.ok, result.message, result.hint, result.details);
    expect(result.ok).toBe(true);
    for (const kind of plugin.lookupKinds) {
      const options = await plugin.lookup(data, summary, kind);
      console.log(
        `${kind}: ${options.length}`,
        options.slice(0, 4).map((o) => o.label),
      );
      if (kind !== 'keyPairs') expect(options.length).toBeGreaterThan(0);
    }
  }, 60_000);
});
