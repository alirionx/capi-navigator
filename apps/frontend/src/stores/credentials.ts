import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  CloudsYamlInfoSchema,
  CredentialListSchema,
  CredentialSchema,
  LookupResponseSchema,
  ManifestPreviewSchema,
  type CloudsYamlInfo,
  type CreateCredentialRequest,
  type Credential,
  type LookupResponse,
  type ManifestPreview,
  type UpdateCredentialRequest,
} from '@capi-navigator/shared';
import { api, apiVoid } from '../api/client.js';

const base = (connection: string) =>
  `/api/connections/${encodeURIComponent(connection)}/credentials`;
const itemPath = (connection: string, c: Pick<Credential, 'provider' | 'name'>) =>
  `${base(connection)}/${c.provider}/${encodeURIComponent(c.name)}`;

/** Infrastructure credentials of the active management cluster (FP-4). */
export const useCredentialsStore = defineStore('credentials', () => {
  const connection = ref<string | null>(null);
  const credentials = ref<Credential[]>([]);
  const loading = ref(false);

  async function load(name: string): Promise<void> {
    connection.value = name;
    loading.value = true;
    try {
      credentials.value = await api('GET', base(name), CredentialListSchema);
    } finally {
      loading.value = false;
    }
  }

  function replace(c: Credential): void {
    const idx = credentials.value.findIndex((x) => x.provider === c.provider && x.name === c.name);
    if (idx >= 0) credentials.value.splice(idx, 1, c);
    else credentials.value.push(c);
  }

  const cloudsYamlInfo = (cloudsYaml: string): Promise<CloudsYamlInfo> =>
    api('POST', `${base(connection.value!)}/clouds-yaml-info`, CloudsYamlInfoSchema, {
      cloudsYaml,
    });

  const preview = (req: CreateCredentialRequest): Promise<ManifestPreview> =>
    api('POST', `${base(connection.value!)}/preview`, ManifestPreviewSchema, req);

  async function create(req: CreateCredentialRequest): Promise<Credential> {
    const c = await api('POST', base(connection.value!), CredentialSchema, req);
    replace(c);
    return c;
  }

  async function update(c: Credential, req: UpdateCredentialRequest): Promise<Credential> {
    const updated = await api('PATCH', itemPath(connection.value!, c), CredentialSchema, req);
    replace(updated);
    return updated;
  }

  async function test(c: Credential): Promise<Credential> {
    const updated = await api('POST', `${itemPath(connection.value!, c)}/test`, CredentialSchema);
    replace(updated);
    return updated;
  }

  async function remove(c: Credential): Promise<void> {
    await apiVoid('DELETE', itemPath(connection.value!, c));
    credentials.value = credentials.value.filter(
      (x) => !(x.provider === c.provider && x.name === c.name),
    );
  }

  const lookup = (c: Credential, kind: string, region?: string): Promise<LookupResponse> =>
    api(
      'GET',
      `${itemPath(connection.value!, c)}/lookups/${kind}${region ? `?region=${encodeURIComponent(region)}` : ''}`,
      LookupResponseSchema,
    );

  return {
    connection,
    credentials,
    loading,
    load,
    cloudsYamlInfo,
    preview,
    create,
    update,
    test,
    remove,
    lookup,
  };
});
