<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  CreateHelmRepositoryRequestSchema,
  type CreateHelmRepositoryRequest,
  type HelmRepository,
  type HelmRepositoryTestResult,
  type HelmRepositoryType,
  type UpdateHelmRepositoryRequest,
} from '@capi-navigator/shared';
import ErrorAlert from '../components/ErrorAlert.vue';
import { useAuthStore } from '../stores/auth.js';
import { useHelmRepositoriesStore } from '../stores/helm-repositories.js';
import FieldHelp from '../components/FieldHelp.vue';

/**
 * Helm repositories (FP8-F-02, FP8-F-03). Password and CA certificate are write-only: the
 * backend never returns them (hard rule 8).
 */
const { t } = useI18n();
const auth = useAuthStore();
const store = useHelmRepositoriesStore();
const isAdmin = computed(() => auth.can('helmRepositories.manage'));
const loadError = ref<unknown>(null);
store.load().catch((err: unknown) => (loadError.value = err));

const headers = computed(() => [
  { title: t('helmRepos.name'), key: 'name' },
  { title: t('helmRepos.type'), key: 'type' },
  { title: t('helmRepos.url'), key: 'url' },
  { title: t('helmRepos.access'), key: 'access', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
]);

// ---- form ----
const open = ref(false);
const editing = ref<HelmRepository | null>(null);
const name = ref('');
const displayName = ref('');
const type = ref<HelmRepositoryType>('http');
const url = ref('');
const useCredentials = ref(false);
const username = ref('');
const password = ref('');
const caCertificate = ref('');
const removeCa = ref(false);
const insecure = ref(false);
const formError = ref<unknown>(null);
const testResult = ref<HelmRepositoryTestResult | null>(null);
const busy = ref(false);
const urlPlaceholder = computed(() =>
  type.value === 'oci'
    ? 'oci://ghcr.io/stefanprodan/charts'
    : 'https://stefanprodan.github.io/podinfo',
);

function openForm(r?: HelmRepository): void {
  editing.value = r ?? null;
  name.value = r?.name ?? '';
  displayName.value = r?.displayName ?? '';
  type.value = r?.type ?? 'http';
  url.value = r?.url ?? '';
  useCredentials.value = r?.hasCredentials ?? false;
  username.value = '';
  password.value = '';
  caCertificate.value = '';
  removeCa.value = false;
  insecure.value = r?.insecureSkipTLSVerify ?? false;
  formError.value = null;
  testResult.value = null;
  open.value = true;
}

const createRequest = (): CreateHelmRepositoryRequest => ({
  name: name.value.trim(),
  ...(displayName.value.trim() ? { displayName: displayName.value.trim() } : {}),
  type: type.value,
  url: url.value.trim(),
  ...(type.value === 'oci'
    ? {
        insecureSkipTLSVerify: insecure.value,
        ...(useCredentials.value && username.value
          ? { credentials: { username: username.value, password: password.value } }
          : {}),
        ...(caCertificate.value.trim() ? { caCertificate: caCertificate.value.trim() } : {}),
      }
    : {}),
});
const createValid = computed(() => CreateHelmRepositoryRequestSchema.safeParse(createRequest()));
const urlError = computed(() =>
  !url.value || createValid.value.success
    ? []
    : createValid.value.error.issues.filter((i) => i.path[0] === 'url').map((i) => i.message),
);
const valid = computed(() =>
  editing.value
    ? !!url.value.trim() &&
      !(useCredentials.value && !editing.value.hasCredentials && !username.value)
    : createValid.value.success && !(useCredentials.value && (!username.value || !password.value)),
);

async function testDraft(): Promise<void> {
  busy.value = true;
  formError.value = null;
  testResult.value = null;
  try {
    testResult.value =
      editing.value && !username.value && !caCertificate.value
        ? await store.test(editing.value.name)
        : await store.testDraft({
            ...createRequest(),
            name: editing.value?.name ?? createRequest().name,
          });
  } catch (err) {
    formError.value = err;
  } finally {
    busy.value = false;
  }
}

async function save(): Promise<void> {
  busy.value = true;
  formError.value = null;
  try {
    if (editing.value) {
      const req: UpdateHelmRepositoryRequest = {
        displayName: displayName.value.trim(),
        url: url.value.trim(),
        ...(type.value === 'oci' ? { insecureSkipTLSVerify: insecure.value } : {}),
        ...(type.value === 'oci' && !useCredentials.value && editing.value.hasCredentials
          ? { credentials: null }
          : {}),
        ...(useCredentials.value && username.value
          ? { credentials: { username: username.value, password: password.value } }
          : {}),
        ...(caCertificate.value.trim() ? { caCertificate: caCertificate.value.trim() } : {}),
        ...(removeCa.value && !caCertificate.value.trim() ? { caCertificate: null } : {}),
      };
      await store.update(editing.value.name, req);
    } else {
      await store.create(createRequest());
    }
    open.value = false;
  } catch (err) {
    formError.value = err;
  } finally {
    busy.value = false;
  }
}

async function readCa(files: File | File[] | null): Promise<void> {
  const file = Array.isArray(files) ? files[0] : files;
  if (file) caCertificate.value = await file.text();
}

// ---- row actions ----
const rowResult = ref<Record<string, HelmRepositoryTestResult | 'busy'>>({});
async function testRow(r: HelmRepository): Promise<void> {
  rowResult.value[r.name] = 'busy';
  try {
    rowResult.value[r.name] = await store.test(r.name);
  } catch (err) {
    rowResult.value[r.name] = {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
const deleting = ref<HelmRepository | null>(null);
const deleteError = ref<unknown>(null);
async function confirmDelete(): Promise<void> {
  deleteError.value = null;
  try {
    await store.remove(deleting.value!.name);
    deleting.value = null;
  } catch (err) {
    deleteError.value = err;
  }
}
</script>

<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <div>
        <h1 class="page-title">{{ t('helmRepos.title') }}</h1>
        <p class="text-body-medium text-medium-emphasis mt-1">{{ t('helmRepos.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-btn
        v-if="isAdmin"
        color="primary"
        prepend-icon="mdi-plus"
        data-testid="add-helm-repo"
        @click="openForm()"
        >{{ t('helmRepos.add') }}</v-btn
      >
    </div>
    <ErrorAlert v-if="loadError" :error="loadError" class="mb-4" />

    <v-card border>
      <v-data-table
        :headers="headers"
        :items="store.repositories"
        item-value="name"
        :loading="store.loading"
        :no-data-text="t('helmRepos.empty')"
        data-testid="helm-repos-table"
      >
        <template #[`item.name`]="{ item }">
          <span class="font-weight-medium">{{ item.name }}</span>
          <div v-if="item.displayName" class="text-body-small text-medium-emphasis">
            {{ item.displayName }}
          </div>
        </template>
        <template #[`item.type`]="{ item }">
          <v-chip size="small" variant="tonal">{{ item.type.toUpperCase() }}</v-chip>
        </template>
        <template #[`item.access`]="{ item }">
          <v-chip v-if="item.hasCredentials" size="x-small" variant="tonal" class="mr-1">{{
            t('helmRepos.credentials')
          }}</v-chip>
          <v-chip v-if="item.hasCaCertificate" size="x-small" variant="tonal" class="mr-1">{{
            t('helmRepos.ca')
          }}</v-chip>
          <v-chip
            v-if="item.insecureSkipTLSVerify"
            size="x-small"
            color="warning"
            variant="tonal"
            >{{ t('helmRepos.insecure') }}</v-chip
          >
          <span
            v-if="!item.hasCredentials && !item.hasCaCertificate && !item.insecureSkipTLSVerify"
            class="text-body-small text-medium-emphasis"
            >{{ t('helmRepos.public') }}</span
          >
          <div
            v-if="rowResult[item.name] && rowResult[item.name] !== 'busy'"
            class="text-body-small mt-1"
            :class="
              (rowResult[item.name] as HelmRepositoryTestResult).ok ? 'text-success' : 'text-error'
            "
            :data-testid="`helm-repo-test-${item.name}`"
          >
            {{ (rowResult[item.name] as HelmRepositoryTestResult).message }}
          </div>
        </template>
        <template #[`item.actions`]="{ item }">
          <div v-if="isAdmin" class="d-flex justify-end ga-1">
            <v-btn
              size="small"
              variant="text"
              :loading="rowResult[item.name] === 'busy'"
              @click="testRow(item)"
              >{{ t('helmRepos.test') }}</v-btn
            >
            <v-btn
              icon="mdi-pencil"
              size="small"
              variant="text"
              :aria-label="t('helmRepos.edit')"
              @click="openForm(item)"
            />
            <v-btn
              icon="mdi-delete"
              size="small"
              variant="text"
              color="error"
              :aria-label="t('common.delete')"
              @click="
                deleting = item;
                deleteError = null;
              "
            />
          </div>
        </template>
      </v-data-table>
    </v-card>

    <v-dialog v-model="open" max-width="640" scrollable>
      <v-card
        :title="
          editing ? t('helmRepos.editTitle', { name: editing.name }) : t('helmRepos.addTitle')
        "
        data-testid="helm-repo-dialog"
      >
        <v-card-text>
          <v-text-field
            v-model="name"
            :label="t('helmRepos.name')"
            :disabled="!!editing"
            data-testid="helm-repo-name"
          >
            <template #append-inner>
              <FieldHelp :text="t('helmRepos.nameHint')" />
            </template>
          </v-text-field>
          <v-text-field v-model="displayName" :label="t('helmRepos.displayName')" />
          <v-btn-toggle
            v-model="type"
            mandatory
            divided
            variant="outlined"
            density="compact"
            class="mt-3"
            :disabled="!!editing"
          >
            <v-btn value="http" data-testid="helm-repo-type-http">HTTP</v-btn>
            <v-btn value="oci" data-testid="helm-repo-type-oci">OCI</v-btn>
          </v-btn-toggle>
          <v-text-field
            v-model="url"
            :label="t('helmRepos.url')"
            :placeholder="urlPlaceholder"
            :error-messages="urlError"
            class="mt-3"
            data-testid="helm-repo-url"
          >
            <template #append-inner>
              <FieldHelp
                :text="type === 'oci' ? t('helmRepos.ociUrlHint') : t('helmRepos.httpUrlHint')"
              />
            </template>
          </v-text-field>
          <template v-if="type === 'oci'">
            <v-checkbox
              v-model="useCredentials"
              :label="t('helmRepos.useCredentials')"
              hide-details
              class="mt-2"
            />
            <v-row v-if="useCredentials" density="compact">
              <v-col cols="6">
                <v-text-field
                  v-model="username"
                  :label="t('helmRepos.username')"
                  :placeholder="editing?.hasCredentials ? t('helmRepos.keep') : ''"
                  autocomplete="off"
                />
              </v-col>
              <v-col cols="6">
                <v-text-field
                  v-model="password"
                  type="password"
                  :label="t('helmRepos.password')"
                  :placeholder="editing?.hasCredentials ? t('helmRepos.keep') : ''"
                  autocomplete="new-password"
                />
              </v-col>
            </v-row>
            <v-file-input
              :label="t('helmRepos.caFile')"
              accept=".crt,.pem"
              prepend-icon="mdi-certificate"
              class="mt-2"
              @update:model-value="readCa"
            >
              <template #append-inner>
                <FieldHelp
                  :text="editing?.hasCaCertificate ? t('helmRepos.caKeep') : t('helmRepos.caHint')"
                />
              </template>
            </v-file-input>
            <v-checkbox
              v-if="editing?.hasCaCertificate"
              v-model="removeCa"
              :label="t('helmRepos.removeCa')"
              hide-details
              density="compact"
            />
            <v-checkbox
              v-model="insecure"
              :label="t('helmRepos.insecureLabel')"
              color="warning"
              hide-details
              density="compact"
            />
          </template>
          <v-alert
            v-if="type === 'http'"
            type="info"
            variant="tonal"
            density="compact"
            class="mt-3"
            >{{ t('helmRepos.httpInfo') }}</v-alert
          >
          <v-alert
            v-if="testResult"
            :type="testResult.ok ? 'success' : 'error'"
            variant="tonal"
            density="compact"
            class="mt-3"
            data-testid="helm-repo-test-result"
          >
            {{ testResult.message }}
            <div v-if="testResult.hint" class="text-body-small">{{ testResult.hint }}</div>
          </v-alert>
          <ErrorAlert v-if="formError" :error="formError" class="mt-3" />
        </v-card-text>
        <v-card-actions>
          <v-btn
            :disabled="!valid"
            :loading="busy"
            data-testid="helm-repo-test"
            @click="testDraft"
            >{{ t('helmRepos.test') }}</v-btn
          >
          <v-spacer />
          <v-btn @click="open = false">{{ t('common.cancel') }}</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :disabled="!valid"
            :loading="busy"
            data-testid="helm-repo-save"
            @click="save"
            >{{ t('common.save') }}</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="!!deleting" max-width="480" @update:model-value="deleting = null">
      <v-card v-if="deleting" :title="t('helmRepos.deleteTitle', { name: deleting.name })">
        <v-card-text>
          {{ t('helmRepos.deleteText') }}
          <ErrorAlert v-if="deleteError" :error="deleteError" class="mt-3" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleting = null">{{ t('common.cancel') }}</v-btn>
          <v-btn
            color="error"
            variant="flat"
            data-testid="helm-repo-delete"
            @click="confirmDelete"
            >{{ t('common.delete') }}</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
