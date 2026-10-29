import {
  DescribeAvailabilityZonesCommand,
  DescribeImagesCommand,
  DescribeInstanceTypesCommand,
  DescribeKeyPairsCommand,
  DescribeRegionsCommand,
  EC2Client,
  type InstanceTypeInfo,
} from '@aws-sdk/client-ec2';
import { GetInstanceProfileCommand, GetRoleCommand, IAMClient } from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { Agent } from 'node:https';
import {
  AWS_IDENTITY,
  AwsCredentialInputSchema,
  CANONICAL_AWS_OWNER,
  DEBIAN_AWS_OWNER,
  ROCKY_AWS_OWNER,
  CAPA_IAM,
  LOOKUP_KINDS,
  type AwsCredentialInput,
  type CredentialSummary,
  type CredentialTestResult,
  type LookupKind,
  type LookupOption,
} from '@capi-navigator/shared';
import { CredentialInputError, type CredentialPlugin } from '../credential-plugin.js';

/** The SDK calls the plugin needs; replaceable in tests. */
export interface AwsClients {
  sts: { send(cmd: unknown): Promise<unknown> };
  iam: { send(cmd: unknown): Promise<unknown> };
  ec2: { send(cmd: unknown): Promise<unknown> };
}
export type AwsClientFactory = (region: string, data: Record<string, string>) => AwsClients;

const TIMEOUT_MS = 15_000;

/**
 * FP29-F-01: the SDK brings its own https.Agent, which ignores NODE_USE_ENV_PROXY (only Node's
 * global agent and fetch honour it). An agent with proxyEnv sends the calls through the proxy.
 */
export function httpsAgent(env: NodeJS.ProcessEnv = process.env): Agent {
  return new Agent({
    keepAlive: true,
    ...(env.NODE_USE_ENV_PROXY === '1' ? { proxyEnv: env } : {}),
  });
}

export const sdkClients: AwsClientFactory = (region, data) => {
  const config = {
    region,
    credentials: {
      accessKeyId: data.AccessKeyID ?? '',
      secretAccessKey: data.SecretAccessKey ?? '',
      ...(data.SessionToken ? { sessionToken: data.SessionToken } : {}),
    },
    maxAttempts: 2,
    requestHandler: {
      requestTimeout: TIMEOUT_MS,
      connectionTimeout: TIMEOUT_MS,
      httpsAgent: httpsAgent(),
    },
  };
  // IAM is a global service; its API lives in us-east-1 (aws partition).
  return {
    sts: new STSClient(config),
    iam: new IAMClient({ ...config, region: 'us-east-1' }),
    ec2: new EC2Client(config),
  };
};

/**
 * Official OS images per publisher account (verified 2026-10-17): Canonical (Ubuntu), the Debian
 * cloud team (wiki.debian.org/Cloud/AmazonEC2Image) and the Rocky Enterprise Software Foundation.
 * Support level for RKE2 per the SUSE RKE2 support matrix (v1.36): Ubuntu and Rocky (as RHEL
 * derivative) are validated, Debian is not. Name patterns checked against eu-central-1 on 2026-10-17;
 * Rocky publishes Base and LVM variants, Base is the one for cluster nodes.
 */
const OS_IMAGES = [
  {
    distro: 'ubuntu',
    release: '24.04',
    owner: CANONICAL_AWS_OWNER,
    pattern: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*',
    support: 'validated',
  },
  {
    distro: 'ubuntu',
    release: '22.04',
    owner: CANONICAL_AWS_OWNER,
    pattern: 'ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*',
    support: 'validated',
  },
  {
    distro: 'rocky',
    release: '10',
    owner: ROCKY_AWS_OWNER,
    pattern: 'Rocky-10-EC2-Base-*',
    support: 'validated',
  },
  {
    distro: 'rocky',
    release: '9',
    owner: ROCKY_AWS_OWNER,
    pattern: 'Rocky-9-EC2-Base-*',
    support: 'validated',
  },
  {
    distro: 'debian',
    release: '13',
    owner: DEBIAN_AWS_OWNER,
    pattern: 'debian-13-amd64-*',
    support: 'community',
  },
  {
    distro: 'debian',
    release: '12',
    owner: DEBIAN_AWS_OWNER,
    pattern: 'debian-12-amd64-*',
    support: 'community',
  },
] as const;

const DISTRO_LABEL = { ubuntu: 'Ubuntu', rocky: 'Rocky Linux', debian: 'Debian' } as const;

/** AWS credentials for CAPA as AWSClusterStaticIdentity (FP4-F-07..10, ADR-0002). */
export class AwsCredentialPlugin implements CredentialPlugin<AwsCredentialInput> {
  readonly provider = 'aws' as const;
  readonly catalogId = 'aws';
  readonly lookupKinds = LOOKUP_KINDS.aws;

  constructor(private readonly clients: AwsClientFactory = sdkClients) {}

  normalize(input: AwsCredentialInput) {
    const parsed = AwsCredentialInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new CredentialInputError(
        parsed.error.issues[0]?.message ?? 'Invalid AWS credentials',
        undefined,
        'aws',
      );
    }
    const v = parsed.data;
    // Secret keys as CAPA expects them (awsidentity_types.go).
    const data: Record<string, string> = {
      AccessKeyID: v.accessKeyId,
      SecretAccessKey: v.secretAccessKey,
      ...(v.sessionToken ? { SessionToken: v.sessionToken } : {}),
    };
    // The default region is not part of the CAPA Secret; it lives in the summary annotation.
    return { data, summary: { region: v.region, accessKeyIdSuffix: v.accessKeyId.slice(-4) } };
  }

  readonly identity = {
    resource: AWS_IDENTITY,
    build(name: string, secret: { name: string; namespace: string }, namespaces: string[]) {
      return {
        apiVersion: AWS_IDENTITY.apiVersion,
        kind: AWS_IDENTITY.kind,
        metadata: { name },
        spec: {
          // The Secret must live in the CAPA controller namespace; secretRef is the name only.
          secretRef: secret.name,
          allowedNamespaces: { list: [...namespaces].sort() },
        },
      };
    },
    allowedNamespaces(identity: Record<string, unknown>): string[] {
      const spec = identity.spec as { allowedNamespaces?: { list?: string[] } } | undefined;
      return spec?.allowedNamespaces?.list ?? [];
    },
  };

  readonly clusterKind = {
    version: 'v1beta2',
    plural: 'awsclusters',
    usesCredential: (cluster: Record<string, unknown>, credential: { name: string }) =>
      (cluster.spec as { identityRef?: { name?: string } } | undefined)?.identityRef?.name ===
      credential.name,
  };

  /** FP4-F-09: caller identity, region and the CAPA IAM prerequisites. Read-only. */
  async test(
    data: Record<string, string>,
    summary: CredentialSummary,
  ): Promise<CredentialTestResult> {
    const testedAt = new Date().toISOString();
    const region = summary.region ?? 'us-east-1';
    const c = this.clients(region, data);
    let identity: string;
    try {
      const id = (await c.sts.send(new GetCallerIdentityCommand({}))) as {
        Account?: string;
        Arn?: string;
      };
      identity = `Account ${id.Account} (${id.Arn})`;
    } catch (err) {
      return {
        ok: false,
        testedAt,
        checks: [{ name: 'Authentication (STS)', ok: false }],
        ...explain(err),
      };
    }
    const checks: CredentialTestResult['checks'] = [{ name: 'Authentication (STS)', ok: true }];
    try {
      await c.ec2.send(new DescribeAvailabilityZonesCommand({}));
      checks.push({ name: `Region ${region}`, ok: true });
    } catch (err) {
      checks.push({ name: `Region ${region}`, ok: false, message: explain(err).message });
    }
    let iamMissing = false;
    for (const role of CAPA_IAM.roles) {
      const name = `${role}${CAPA_IAM.suffix}`;
      const check = await probe(() => c.iam.send(new GetRoleCommand({ RoleName: name })));
      if (check === 'missing') iamMissing = true;
      checks.push(iamCheck(`IAM role ${name}`, check));
    }
    for (const profile of CAPA_IAM.instanceProfiles) {
      const name = `${profile}${CAPA_IAM.suffix}`;
      const check = await probe(() =>
        c.iam.send(new GetInstanceProfileCommand({ InstanceProfileName: name })),
      );
      if (check === 'missing') iamMissing = true;
      checks.push(iamCheck(`IAM instance profile ${name}`, check));
    }
    const failed = checks.filter((x) => !x.ok);
    return {
      ok: failed.length === 0,
      testedAt,
      identity,
      checks,
      ...(iamMissing
        ? {
            message: 'The IAM prerequisites of CAPA are missing',
            hint: 'Create them once per AWS account with clusterawsadm (CAPI Navigator does not create IAM resources).',
            fixCommand: CAPA_IAM.fixCommand.replace('<region>', region),
          }
        : failed.length > 0
          ? {
              message: `${failed.length} check(s) failed`,
              hint: 'Allow iam:GetRole and iam:GetInstanceProfile for the IAM user to verify the prerequisites.',
            }
          : {}),
    };
  }

  async imageNames(
    data: Record<string, string>,
    summary: CredentialSummary,
    ids: string[],
    opts: { region?: string },
  ): Promise<Record<string, string>> {
    const { ec2 } = this.clients(opts.region ?? summary.region ?? 'us-east-1', data);
    const out: Record<string, string> = {};
    // One call per AMI: an unknown ID fails the whole DescribeImages request.
    for (const id of ids) {
      try {
        const res = (await ec2.send(new DescribeImagesCommand({ ImageIds: [id] }))) as {
          Images?: { ImageId?: string; Name?: string }[];
        };
        const name = res.Images?.[0]?.Name;
        if (name) out[id] = name;
      } catch {
        // Deregistered, or not visible to these credentials: shown as ID only.
      }
    }
    return out;
  }

  /** FP4-F-10: selection lists for the cluster wizard. Read-only. */
  async lookup(
    data: Record<string, string>,
    summary: CredentialSummary,
    kind: LookupKind,
    opts: { region?: string },
  ): Promise<LookupOption[]> {
    const region = opts.region ?? summary.region ?? 'us-east-1';
    const { ec2 } = this.clients(region, data);
    try {
      switch (kind) {
        case 'regions': {
          const res = (await ec2.send(new DescribeRegionsCommand({}))) as {
            Regions?: { RegionName?: string }[];
          };
          return (res.Regions ?? [])
            .map((r) => r.RegionName!)
            .sort()
            .map((r) => ({ value: r, label: r }));
        }
        case 'availabilityZones': {
          const res = (await ec2.send(
            new DescribeAvailabilityZonesCommand({
              Filters: [{ Name: 'state', Values: ['available'] }],
            }),
          )) as { AvailabilityZones?: { ZoneName?: string; ZoneType?: string }[] };
          return (res.AvailabilityZones ?? [])
            .filter((z) => !z.ZoneType || z.ZoneType === 'availability-zone')
            .map((z) => ({ value: z.ZoneName!, label: z.ZoneName! }));
        }
        case 'instanceTypes': {
          const types: InstanceTypeInfo[] = [];
          let token: string | undefined;
          do {
            const res = (await ec2.send(
              new DescribeInstanceTypesCommand({
                Filters: [
                  { Name: 'current-generation', Values: ['true'] },
                  { Name: 'processor-info.supported-architecture', Values: ['x86_64'] },
                ],
                MaxResults: 100,
                NextToken: token,
              }),
            )) as { InstanceTypes?: InstanceTypeInfo[]; NextToken?: string };
            types.push(...(res.InstanceTypes ?? []));
            token = res.NextToken;
          } while (token && types.length < 2000);
          return types
            .map((t) => ({
              type: t.InstanceType!,
              vcpus: t.VCpuInfo?.DefaultVCpus ?? 0,
              mem: t.MemoryInfo?.SizeInMiB ?? 0,
            }))
            .sort((a, b) => a.vcpus - b.vcpus || a.mem - b.mem || a.type.localeCompare(b.type))
            .map((t) => ({
              value: t.type,
              label: `${t.type} (${t.vcpus} vCPU, ${Math.round((t.mem / 1024) * 10) / 10} GiB RAM)`,
              details: { vcpus: t.vcpus, memoryMiB: t.mem },
            }));
        }
        case 'images': {
          const options: LookupOption[] = [];
          for (const os of OS_IMAGES) {
            const res = (await ec2.send(
              new DescribeImagesCommand({
                Owners: [os.owner],
                Filters: [
                  { Name: 'name', Values: [os.pattern] },
                  { Name: 'state', Values: ['available'] },
                  { Name: 'architecture', Values: ['x86_64'] },
                ],
              }),
            )) as { Images?: { ImageId?: string; Name?: string; CreationDate?: string }[] };
            const newest = (res.Images ?? [])
              .sort((a, b) => (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''))
              .slice(0, 3);
            for (const img of newest) {
              options.push({
                value: img.ImageId!,
                label: `${DISTRO_LABEL[os.distro]} ${os.release} – ${img.Name?.split('/').pop() ?? img.ImageId}`,
                details: {
                  os_distro: os.distro,
                  os_version: os.release,
                  rke2_support: os.support,
                  created_at: img.CreationDate ?? '',
                },
              });
            }
          }
          return options;
        }
        case 'keyPairs': {
          const res = (await ec2.send(new DescribeKeyPairsCommand({}))) as {
            KeyPairs?: { KeyName?: string; KeyFingerprint?: string; KeyType?: string }[];
          };
          // The fingerprint (public) helps to pick the key pair that matches a local key.
          return (res.KeyPairs ?? []).map((k) => ({
            value: k.KeyName!,
            label: k.KeyName!,
            details: Object.fromEntries(
              Object.entries({ fingerprint: k.KeyFingerprint, type: k.KeyType }).filter(
                (e): e is [string, string] => typeof e[1] === 'string',
              ),
            ),
          }));
        }
        default:
          throw new CredentialInputError(`Unknown selection list "${kind}" for AWS`);
      }
    } catch (err) {
      if (err instanceof CredentialInputError) throw err;
      const e = explain(err);
      throw new CredentialInputError(e.message, e.hint);
    }
  }
}

type ProbeResult = 'ok' | 'missing' | { error: string };

async function probe(fn: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    if (awsErrorName(err) === 'NoSuchEntity' || awsErrorName(err) === 'NoSuchEntityException')
      return 'missing';
    return { error: explain(err).message };
  }
}

function iamCheck(name: string, result: ProbeResult) {
  if (result === 'ok') return { name, ok: true };
  if (result === 'missing') return { name, ok: false, message: 'Missing' };
  return { name, ok: false, message: result.error };
}

function awsErrorName(err: unknown): string {
  return (err as { name?: string; Code?: string }).name ?? (err as { Code?: string }).Code ?? '';
}

/** Understandable AWS errors (NF-06); never includes the secret key. */
function explain(err: unknown): { message: string; hint?: string; details?: string } {
  const name = awsErrorName(err);
  const details = err instanceof Error ? err.message.slice(0, 500) : undefined;
  const base = details ? { details } : {};
  if (
    ['InvalidClientTokenId', 'SignatureDoesNotMatch', 'UnrecognizedClientException'].includes(name)
  ) {
    return {
      ...base,
      message: 'AWS rejected the access key',
      hint: 'Check the access key ID and secret access key; the key may be deactivated or deleted.',
    };
  }
  if (name === 'ExpiredToken' || name === 'ExpiredTokenException') {
    return {
      ...base,
      message: 'The temporary credentials have expired',
      hint: 'Use a long-lived access key of an IAM user.',
    };
  }
  if (
    name === 'AccessDenied' ||
    name === 'AccessDeniedException' ||
    name === 'UnauthorizedOperation'
  ) {
    return {
      ...base,
      message: 'Permission denied',
      hint: 'Grant the IAM user the CAPA controller permissions.',
    };
  }
  if (name === 'AuthFailure') {
    return {
      ...base,
      message: 'AWS rejected the request for this region',
      hint: 'Check that the region is enabled for the account.',
    };
  }
  return {
    ...base,
    message: 'AWS is not reachable or answered with an error',
    hint: 'Check network access to the AWS APIs.',
  };
}
