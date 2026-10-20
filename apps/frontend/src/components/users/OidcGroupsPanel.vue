<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  OidcGroupNameSchema,
  type GroupMapping,
  type RoleBinding,
  type RoleInfo,
} from '@capi-navigator/shared';
import ErrorAlert from '../ErrorAlert.vue';
import BindingsEditor from './BindingsEditor.vue';
import { zodRule } from '../../forms/zod-rules.js';
import { useOidcGroupsStore } from '../../stores/oidcGroups.js';

/**
 * Mappings of OpenID Connect groups to role assignments (FP14-F-04): people of a mapped group get
 * these assignments; nobody has to be created in the app.
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
  { title: t('oidcGroups.group'), key: 'group' },
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
const form = ref({ group: '', description: '', bindings: [] as RoleBinding[] });
const valid = ref(false);
const busy = ref(false);
const dialogError = ref<unknown>(null);

function open(kind: DialogKind, mapping?: GroupMapping): void {
  target.value = mapping ?? null;
  dialogError.value = null;
  form.value = {
    group: mapping?.group ?? '',
    description: mapping?.description ?? '',
    // Plain copy: the store's mappings are reactive proxies.
    bindings: JSON.parse(
      JSON.stringify(mapping?.bindings ?? [{ role: 'viewer' }]),
    ) as RoleBinding[],
  };
  dialog.value = kind;
}

async function confirm(): Promise<void> {
  busy.value = true;
  dialogError.value = null;
  const description = form.value.description.trim() || undefined;
  try {
    if (dialog.value === 'create') {
      await store.create({ group: form.value.group, description, bindings: form.value.bindings });
    } else if (dialog.value === 'edit' && target.value) {
      await store.update(target.value.name, { description, bindings: form.value.bindings });
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
        <h2 class="text-h6">{{ t('oidcGroups.title') }}</h2>
        <p class="text-body-2 text-medium-emphasis mt-1">{{ t('oidcGroups.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-btn
        color="primary"
        variant="tonal"
        prepend-icon="mdi-account-group"
        data-testid="oidc-group-add"
        @click="open('create')"
        >{{ t('oidcGroups.add') }}</v-btn
      >
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
        <template #[`item.group`]="{ item }">
          <span class="font-weight-medium">{{ item.group }}</span>
          <div v-if="item.description" class="text-caption text-medium-emphasis">
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
            :data-testid="`oidc-group-edit-${item.group}`"
            @click="open('edit', item)"
          />
          <v-btn
            icon="mdi-delete"
            variant="text"
            size="small"
            color="error"
            :title="t('common.delete')"
            :aria-label="t('common.delete')"
            :data-testid="`oidc-group-delete-${item.group}`"
            @click="open('delete', item)"
          />
        </template>
      </v-data-table>
    </v-card>

    <v-dialog :model-value="dialog !== null" max-width="640" @update:model-value="dialog = null">
      <v-card v-if="dialog" data-testid="oidc-group-dialog">
        <v-card-title class="pt-4 px-6">
          <template v-if="dialog === 'create'">{{ t('oidcGroups.add') }}</template>
          <template v-else-if="dialog === 'edit'">
            {{ t('oidcGroups.editTitle', { group: target?.group }) }}
          </template>
          <template v-else>{{ t('oidcGroups.deleteTitle', { group: target?.group }) }}</template>
        </v-card-title>
        <v-card-text>
          <v-form v-model="valid" @submit.prevent="confirm">
            <template v-if="dialog !== 'delete'">
              <v-text-field
                v-model="form.group"
                :label="t('oidcGroups.group')"
                :hint="t('oidcGroups.groupHint')"
                persistent-hint
                :rules="[zodRule(OidcGroupNameSchema)]"
                :disabled="dialog === 'edit'"
                class="mb-2"
                data-testid="oidc-group-name"
              />
              <v-text-field
                v-model="form.description"
                :label="t('oidcGroups.description')"
                :hint="t('oidcGroups.descriptionHint')"
                persistent-hint
                class="mb-2"
              />
              <div class="text-subtitle-2 mt-2">{{ t('users.bindings') }}</div>
              <p class="text-caption text-medium-emphasis mb-2">
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
