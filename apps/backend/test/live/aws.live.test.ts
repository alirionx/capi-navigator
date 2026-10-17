// Opt-in, read-only test against a real AWS account (FP-4 acceptance). Runs only with
// AWS_LIVE_ACCESS_KEY_ID, AWS_LIVE_SECRET_ACCESS_KEY and AWS_LIVE_REGION; prints no secrets.
// Calls only STS GetCallerIdentity, IAM Get*, and EC2 Describe*; creates nothing.
import { describe, expect, it } from 'vitest';
import { AwsCredentialPlugin } from '../../src/infra-providers/aws/aws-credential.plugin.js';

const id = process.env.AWS_LIVE_ACCESS_KEY_ID;
const secret = process.env.AWS_LIVE_SECRET_ACCESS_KEY;
const region = process.env.AWS_LIVE_REGION ?? 'eu-central-1';

describe.skipIf(!id || !secret)('AWS credentials against a real account (read-only)', () => {
  it('tests the key and lists regions, instance types, Ubuntu AMIs and key pairs', async () => {
    const plugin = new AwsCredentialPlugin();
    const { data, summary } = plugin.normalize({
      accessKeyId: id!,
      secretAccessKey: secret!,
      region,
    });
    const result = await plugin.test(data, summary);
    console.log('test', result.ok, result.identity, result.message, result.fixCommand ?? '');
    console.log(
      result.checks.map((c) => `${c.ok ? 'ok ' : 'NO '} ${c.name} ${c.message ?? ''}`).join('\n'),
    );
    expect(result.checks[0]!.ok).toBe(true);
    for (const kind of plugin.lookupKinds) {
      const options = await plugin.lookup(data, summary, kind, {});
      console.log(
        `${kind}: ${options.length}`,
        options.slice(0, 3).map((o) => o.label),
      );
      if (kind !== 'keyPairs') expect(options.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
