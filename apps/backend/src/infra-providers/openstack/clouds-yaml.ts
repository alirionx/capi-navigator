import type { CloudsYamlInfo, OpenStackCredentialInput } from '@capi-navigator/shared';
import { parse, stringify } from 'yaml';

/** A user-fixable problem with OpenStack credentials; never contains secret values. */
export class OpenStackCredentialError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** One cloud entry of a clouds.yaml, as used by CAPO, the CCM and openstacksdk. */
export interface CloudEntry {
  auth: Record<string, string>;
  region_name?: string;
  interface?: string;
  identity_api_version?: number | string;
  auth_type?: string;
  [key: string]: unknown;
}

const SUPPORTED_AUTH_TYPES = ['v3applicationcredential', 'password', 'v3password'];

function parseClouds(text: string): Record<string, CloudEntry> {
  let doc: unknown;
  try {
    doc = parse(text, { maxAliasCount: 50 });
  } catch {
    throw new OpenStackCredentialError('The clouds.yaml is not valid YAML');
  }
  const clouds = (doc as { clouds?: unknown } | null)?.clouds;
  if (!clouds || typeof clouds !== 'object' || Array.isArray(clouds)) {
    throw new OpenStackCredentialError(
      'The file has no "clouds:" section',
      'Download the clouds.yaml from the OpenStack dashboard (API access → OpenStack clouds.yaml file).',
    );
  }
  return clouds as Record<string, CloudEntry>;
}

/** Lists the clouds of a clouds.yaml without any secrets (for the form). */
export function cloudsYamlInfo(text: string): CloudsYamlInfo {
  const clouds = parseClouds(text);
  return {
    clouds: Object.entries(clouds).map(([name, c]) => ({
      name,
      ...(typeof c.auth?.auth_url === 'string' ? { authUrl: c.auth.auth_url } : {}),
      ...(typeof c.region_name === 'string' ? { region: c.region_name } : {}),
      ...(typeof c.auth_type === 'string' ? { authType: c.auth_type } : {}),
    })),
  };
}

function authType(c: CloudEntry): string {
  if (c.auth_type) return c.auth_type;
  return c.auth?.application_credential_id ? 'v3applicationcredential' : 'password';
}

/** Validates one cloud entry: supported auth type, https auth URL, required fields. */
function validate(name: string, c: CloudEntry): void {
  const type = authType(c);
  if (!SUPPORTED_AUTH_TYPES.includes(type)) {
    throw new OpenStackCredentialError(
      `Cloud "${name}" uses auth type "${type}", which is not supported`,
      'Use an application credential (recommended) or username/password.',
    );
  }
  const url = c.auth?.auth_url;
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
    throw new OpenStackCredentialError(`Cloud "${name}" has no https:// auth_url`);
  }
  if (type === 'v3applicationcredential') {
    if (!c.auth.application_credential_id || !c.auth.application_credential_secret) {
      throw new OpenStackCredentialError(
        `Cloud "${name}" lacks application_credential_id or application_credential_secret`,
        'The clouds.yaml from Horizon omits the secret; add it from the creation dialog.',
      );
    }
  } else if (!c.auth.username || !c.auth.password) {
    throw new OpenStackCredentialError(
      `Cloud "${name}" lacks username or password`,
      'Add the password to the clouds.yaml, or prefer an application credential.',
    );
  }
}

export interface NormalizedOpenStackCredential {
  cloudName: string;
  cloud: CloudEntry;
  /** clouds.yaml with exactly this one cloud, as stored in the Secret (key clouds.yaml). */
  cloudsYaml: string;
  cacert?: string;
}

/** Builds the single-cloud clouds.yaml that is stored (FP4-F-01, FP4-F-03). */
export function normalizeOpenStack(input: OpenStackCredentialInput): NormalizedOpenStackCredential {
  let cloudName: string;
  let cloud: CloudEntry;
  if (input.source === 'clouds.yaml') {
    const clouds = parseClouds(input.cloudsYaml);
    const names = Object.keys(clouds);
    if (names.length === 0) throw new OpenStackCredentialError('The clouds.yaml contains no cloud');
    if (!input.cloudName && names.length > 1) {
      throw new OpenStackCredentialError(
        `The clouds.yaml contains ${names.length} clouds`,
        'Select the cloud to use.',
      );
    }
    cloudName = input.cloudName || names[0]!;
    const entry = clouds[cloudName];
    if (!entry) throw new OpenStackCredentialError(`The clouds.yaml has no cloud "${cloudName}"`);
    cloud = entry;
  } else {
    cloudName = 'openstack';
    const auth: Record<string, string> =
      input.auth.type === 'applicationCredential'
        ? {
            auth_url: input.authUrl,
            application_credential_id: input.auth.applicationCredentialId,
            application_credential_secret: input.auth.applicationCredentialSecret,
          }
        : {
            auth_url: input.authUrl,
            username: input.auth.username,
            password: input.auth.password,
            project_name: input.auth.projectName,
            project_domain_name: input.auth.projectDomainName ?? 'Default',
            user_domain_name: input.auth.userDomainName ?? 'Default',
          };
    cloud = {
      auth,
      region_name: input.region,
      interface: 'public',
      identity_api_version: 3,
      auth_type:
        input.auth.type === 'applicationCredential' ? 'v3applicationcredential' : 'password',
    };
  }
  validate(cloudName, cloud);
  const cacert = input.cacert?.trim() || undefined;
  return {
    cloudName,
    cloud,
    cloudsYaml: stringify({ clouds: { [cloudName]: cloud } }),
    ...(cacert ? { cacert: `${cacert}\n` } : {}),
  };
}

/** Reads a stored single-cloud clouds.yaml back. */
export function readStoredCloud(cloudsYaml: string): { cloudName: string; cloud: CloudEntry } {
  const clouds = parseClouds(cloudsYaml);
  const [cloudName, cloud] = Object.entries(clouds)[0] ?? [];
  if (!cloudName || !cloud) throw new OpenStackCredentialError('The stored clouds.yaml is empty');
  return { cloudName, cloud };
}

export function cloudAuthType(cloud: CloudEntry): string {
  return authType(cloud);
}
