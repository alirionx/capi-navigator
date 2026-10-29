<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  OidcGroupNameSchema,
  OidcSubjectSchema,
  type GroupMapping,
  type OidcSignIn,
  type RoleBinding,
  type RoleInfo,
} from '@capi-navigator/shared';
import ErrorAlert from '../ErrorAlert.vue';
import BindingsEditor from './BindingsEditor.vue';
import { zodRule } from '../../forms/zod-rules.js';
import { useOidcGroupsStore } from '../../stores/oidcGroups.js';

/**
 * Mappings of OpenID Connect groups, and of single people, to role assignments (FP14-F-04): people
 * of a mapped group get these assignments; nobody has to be created in the app. Person mappings
 * are for providers without groups (e.g. Rancher with local accounts).
 */
const props = defineProps<{
  roles: RoleInfo[];
  connections: string[];
  bindingLabel: (b: RoleBinding) => string;
}>();
const { t } = useI18n();
const store = useOidcGroupsStore();

const loadError = ref<unknown>(null);
const headers = computed(() => [
  { title: t('oidcGroups.who'), key: 'who', sortable: false },
  { title: t('users.bindings'), key: 'bindings', sortable: false },
  { title: t('users.actions'), key: 'actions', sortable: false, align: 'end' as const },
]);

onMounted(async () => {
  try {
    await store.load();
  } catch (err) {
    loadError.value = err;
  }
});

type DialogKind = 'create' | 'edit' | 'delete';
const dialog = ref<DialogKind | null>(null);
const target = ref<GroupMapping | null>(null);
type Mode = 'group' | 'person';
const mode = ref<Mode>('group');
const form = ref({
  group: '',
  subject: '',
  displayName: '',
  description: '',
  bindings: [] as RoleBinding[],
});
/** Name of a mapping in lists and titles. */
const label = (m: GroupMapping | null) =>
  m ? (m.group ?? (m.displayName ? `${m.displayName} (${m.subject})` : m.subject)) : '';
const valid = ref(false);
const busy = ref(false);
const dialogError = ref<unknown>(null);

function open(kind: DialogKind, mapping?: GroupMapping, newMode: Mode = 'group'): void {
  target.value = mapping ?? null;
  mode.value = mapping ? mapping.kind : newMode;
  dialogError.value = null;
  form.value = {
    group: mapping?.group ?? '',
    subject: mapping?.subject ?? '',
    displayName: mapping?.displayName ?? '',
    description: mapping?.description ?? '',
    // Plain copy: the store's mappings are reactive proxies.
    bindings: JSON.parse(
      JSON.stringify(mapping?.bindings ?? [{ role: 'viewer' }]),
    ) as RoleBinding[],
  };
  dialog.value = kind;
}

/** FP14-F-15: map a person from the list of recent sign-ins, prefilled. */
function mapPerson(row: OidcSignIn): void {
  open('create', undefined, 'person');
  form.value.subject = row.subject;
  form.value.displayName = row.name;
}

const signInHeaders = computed(() => [
  { title: t('oidcGroups.signIns.name'), key: 'name' },
  { title: t('oidcGroups.subject'), key: 'subject', sortable: false },
  { title: t('oidcGroups.signIns.last'), key: 'lastSignIn' },
  { title: t('oidcGroups.signIns.access'), key: 'access', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
]);
const formatTime = (iso: string) => new Date(iso).toLocaleString();

async function confirm(): Promise<void> {
  busy.value = true;
  dialogError.value = null;
  const description = form.value.description.trim() || undefined;
  const displayName = form.value.displayName.trim() || undefined;
  const bindings = form.value.bindings;
  try {
    if (dialog.value === 'create') {
      await store.create(
        mode.value === 'group'
          ? { group: form.value.group, description, bindings }
          : { subject: form.value.subject, displayName, description, bindings },
      );
    } else if (dialog.value === 'edit' && target.value) {
      await store.update(target.value.name, { displayName, description, bindings });
    } else if (dialog.value === 'delete' && target.value) {
      await store.remove(target.value.name);
    }
    dialog.value = null;
  } catch (err) {
    dialogError.value = err;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div data-testid="oidc-groups">
    <div class="d-flex align-center mt-8 mb-4">
      <div>
        <h2 class="text-title-large">{{ t('oidcGroups.title') }}</h2>
        <p class="text-body-medium text-medium-emphasis mt-1">{{ t('oidcGroups.subtitle') }}</p>
      </div>
      <v-spacer />
      <div class="d-flex ga-2 flex-wrap justify-end">
        <v-btn
          color="primary"
          variant="tonal"
          prepend-icon="mdi-account-group"
          data-testid="oidc-group-add"
          @click="open('create')"
          >{{ t('oidcGroups.add') }}</v-btn
        >
        <v-btn
          color="primary"
          variant="tonal"
          prepend-icon="mdi-account-key"
          data-testid="oidc-person-add"
          @click="open('create', undefined, 'person')"
          >{{ t('oidcGroups.addPerson') }}</v-btn
        >
      </div>
    </div>

    <ErrorAlert v-if="loadError" :error="loadError" class="mb-4" />
    <v-alert
      v-if="!store.loading && !store.oidcEnabled && !loadError"
      type="info"
      variant="tonal"
      density="compact"
      class="mb-4"
      >{{ t('oidcGroups.notConfigured') }}</v-alert
    >

    <v-card border class="table-card">
      <v-data-table
        :headers="headers"
        :items="store.mappings"
        :loading="store.loading"
        item-value="name"
        :no-data-text="t('oidcGroups.empty')"
        data-testid="oidc-groups-table"
      >
        <template #[`item.who`]="{ item }">
          <v-chip
            size="x-small"
            variant="tonal"
            :color="item.kind === 'person' ? 'info' : undefined"
            :prepend-icon="item.kind === 'person' ? 'mdi-account' : 'mdi-account-group'"
            class="mr-2"
            >{{ t(`oidcGroups.kind.${item.kind}`) }}</v-chip
          >
          <span class="font-weight-medium">{{ label(item) }}</span>
          <div v-if="item.description" class="text-body-small text-medium-emphasis">
            {{ item.description }}
          </div>
        </template>
        <template #[`item.bindings`]="{ item }">
          <v-chip
            v-for="(b, i) in item.bindings"
            :key="i"
            size="small"
            variant="tonal"
            class="mr-1 my-1"
            >{{ props.bindingLabel(b) }}</v-chip
          >
        </template>
        <template #[`item.actions`]="{ item }">
          <v-btn
            icon="mdi-pencil"
            variant="text"
            size="small"
            :title="t('users.edit')"
            :aria-label="t('users.edit')"
            :data-testid="`oidc-group-edit-${item.group ?? item.subject}`"
            @click="open('edit', item)"
          />
          <v-btn
            icon="mdi-delete"
            variant="text"
            size="small"
            color="error"
            :title="t('common.delete')"
            :aria-label="t('common.delete')"
            :data-testid="`oidc-group-delete-${item.group ?? item.subject}`"
            @click="open('delete', item)"
          />
        </template>
      </v-data-table>
    </v-card>

    <!-- FP14-F-15: who signed in recently, to map people without typing their ID. -->
    <h3 class="text-body-large font-weight-medium mt-8">{{ t('oidcGroups.signIns.title') }}</h3>
    <p class="text-body-medium text-medium-emphasis mt-1 mb-3">
      {{ t('oidcGroups.signIns.subtitle') }}
    </p>
    <v-card border class="table-card">
      <v-data-table
        :headers="signInHeaders"
        :items="store.signIns"
        :loading="store.loading"
        item-value="subject"
        :no-data-text="t('oidcGroups.signIns.empty')"
        data-testid="oidc-sign-ins"
      >
        <template #[`item.subject`]="{ item }">
          <code class="text-body-small">{{ item.subject }}</code>
        </template>
        <template #[`item.lastSignIn`]="{ item }">
          {{ formatTime(item.lastSignIn) }}
          <v-chip
            v-if="item.outcome === 'failure'"
            size="x-small"
            color="warning"
            variant="tonal"
            class="ml-1"
            >{{ t('oidcGroups.signIns.refused') }}</v-chip
          >
        </template>
        <template #[`item.access`]="{ item }">
          <span>{{ t(`oidcGroups.signIns.kind.${item.access.kind}`) }}</span>
          <span v-if="item.access.detail.length" class="text-medium-emphasis">
            · {{ item.access.detail.join(', ') }}</span
          >
        </template>
        <template #[`item.actions`]="{ item }">
          <v-btn
            v-if="item.access.kind !== 'person'"
            size="small"
            variant="tonal"
            prepend-icon="mdi-account-key"
            :data-testid="`oidc-sign-in-map-${item.subject}`"
            @click="mapPerson(item)"
            >{{ t('oidcGroups.signIns.map') }}</v-btn
          >
        </template>
      </v-data-table>
    </v-card>

    <v-dialog :model-value="dialog !== null" max-width="640" @update:model-value="dialog = null">
      <v-card v-if="dialog" data-testid="oidc-group-dialog">
        <v-card-title class="pt-4 px-6">
          <template v-if="dialog === 'create'">{{
            mode === 'group' ? t('oidcGroups.add') : t('oidcGroups.addPerson')
          }}</template>
          <template v-else-if="dialog === 'edit'">
            {{ t('oidcGroups.editTitle', { group: label(target) }) }}
          </template>
          <template v-else>{{ t('oidcGroups.deleteTitle', { group: label(target) }) }}</template>
        </v-card-title>
        <v-card-text>
          <v-form v-model="valid" @submit.prevent="confirm">
            <template v-if="dialog !== 'delete'">
              <v-text-field
                v-if="mode === 'group'"
                v-model="form.group"
                :label="t('oidcGroups.group')"
                :hint="t('oidcGroups.groupHint')"
                persistent-hint
                :rules="[zodRule(OidcGroupNameSchema)]"
                :disabled="dialog === 'edit'"
                class="mb-2"
                data-testid="oidc-group-name"
              />
              <template v-else>
                <v-text-field
                  v-model="form.subject"
                  :label="t('oidcGroups.subject')"
                  :hint="t('oidcGroups.subjectHint')"
                  persistent-hint
                  :rules="[zodRule(OidcSubjectSchema)]"
                  :disabled="dialog === 'edit'"
                  class="mb-2"
                  data-testid="oidc-person-subject"
                />
                <v-text-field
                  v-model="form.displayName"
                  :label="t('oidcGroups.displayName')"
                  :hint="t('oidcGroups.displayNameHint')"
                  persistent-hint
                  class="mb-2"
                  data-testid="oidc-person-name"
                />
              </template>
              <v-text-field
                v-model="form.description"
                :label="t('oidcGroups.description')"
                :hint="t('oidcGroups.descriptionHint')"
                persistent-hint
                class="mb-2"
              />
              <div class="text-title-small mt-2">{{ t('users.bindings') }}</div>
              <p class="text-body-small text-medium-emphasis mb-2">
                {{ t('oidcGroups.bindingsHint') }}
              </p>
              <BindingsEditor
                v-model="form.bindings"
                :roles="props.roles"
                :connections="props.connections"
                class="mb-2"
              />
            </template>
            <p v-else>{{ t('oidcGroups.deleteText') }}</p>
            <ErrorAlert v-if="dialogError" :error="dialogError" class="mt-4" />
          </v-form>
        </v-card-text>
        <v-card-actions class="px-6 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="dialog = null">{{ t('common.cancel') }}</v-btn>
          <v-btn
            :color="dialog === 'delete' ? 'error' : 'primary'"
            variant="flat"
            :loading="busy"
            :disabled="dialog !== 'delete' && (!valid || form.bindings.length === 0)"
            data-testid="oidc-group-confirm"
            @click="confirm"
          >
            {{
              dialog === 'create'
                ? t('common.create')
                : dialog === 'delete'
                  ? t('common.delete')
                  : t('common.save')
            }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
