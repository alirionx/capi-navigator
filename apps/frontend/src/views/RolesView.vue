<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  isScopable,
  PERMISSION_GROUPS,
  RoleNameSchema,
  type Permission,
  type RoleInfo,
} from '@capi-navigator/shared';
import { ApiError } from '../api/client.js';
import ErrorAlert from '../components/ErrorAlert.vue';
import { fieldErrors, zodRule } from '../forms/zod-rules.js';
import { useRolesStore } from '../stores/roles.js';
import FieldHelp from '../components/FieldHelp.vue';

/** Roles page (FP19-F-09): built-in and custom roles, permissions grouped with help texts. */
const { t } = useI18n();
const store = useRolesStore();

const loadError = ref<unknown>(null);
const headers = computed(() => [
  { title: t('rolesPage.name'), key: 'name' },
  { title: t('rolesPage.permissions'), key: 'permissions', sortable: false },
  { title: t('rolesPage.users'), key: 'users', sortable: false },
  { title: t('users.actions'), key: 'actions', sortable: false, align: 'end' as const },
]);

async function reload(): Promise<void> {
  loadError.value = null;
  try {
    await store.load();
  } catch (err) {
    loadError.value = err;
  }
}
onMounted(reload);

const title = (r: RoleInfo) => (r.builtin ? t(`roles.${r.name}`) : r.displayName);
const isPlatform = (p: Permission) => p !== 'view' && !isScopable(p);

type DialogKind = 'create' | 'edit' | 'delete';
const dialog = ref<DialogKind | null>(null);
const target = ref<RoleInfo | null>(null);
const busy = ref(false);
const dialogError = ref<unknown>(null);
const valid = ref(false);
const form = ref({
  name: '',
  displayName: '',
  description: '',
  permissions: ['view'] as Permission[],
});
const serverFieldErrors = computed(() =>
  dialogError.value instanceof ApiError ? dialogError.value.fieldErrors : undefined,
);

/** Create, edit, or copy (create prefilled from another role, also a built-in one). */
function open(kind: DialogKind, role?: RoleInfo, copy = false): void {
  target.value = role ?? null;
  dialogError.value = null;
  form.value = {
    name: copy ? `${role!.name}-copy` : (role?.name ?? ''),
    displayName: copy ? t('rolesPage.copyOf', { name: title(role!) }) : (role?.displayName ?? ''),
    description: role?.description ?? '',
    permissions: [...new Set<Permission>(['view', ...(role?.permissions ?? [])])],
  };
  dialog.value = kind;
}

async function confirm(): Promise<void> {
  busy.value = true;
  dialogError.value = null;
  const fields = {
    displayName: form.value.displayName,
    ...(form.value.description.trim() ? { description: form.value.description } : {}),
    permissions: form.value.permissions.filter((p) => p !== 'view'),
  };
  try {
    if (dialog.value === 'create') await store.create({ name: form.value.name, ...fields });
    else if (dialog.value === 'edit') await store.update(target.value!.name, fields);
    else await store.remove(target.value!.name);
    dialog.value = null;
  } catch (err) {
    dialogError.value = err;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-container>
    <div class="d-flex align-center mb-4">
      <div>
        <h1 class="page-title">{{ t('rolesPage.title') }}</h1>
        <p class="text-body-medium text-medium-emphasis mt-1">{{ t('rolesPage.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-btn
        color="primary"
        prepend-icon="mdi-shield-plus"
        data-testid="role-add"
        @click="open('create')"
      >
        {{ t('rolesPage.add') }}
      </v-btn>
    </div>

    <ErrorAlert v-if="loadError" :error="loadError" class="mb-4" />

    <v-card border class="table-card">
      <v-data-table
        :headers="headers"
        :items="store.roles"
        :loading="store.loading"
        item-value="name"
        data-testid="roles-table"
      >
        <template #[`item.name`]="{ item }">
          <div class="font-weight-medium">{{ title(item) }}</div>
          <div class="text-body-small text-medium-emphasis">
            {{ item.name }}
            <v-chip v-if="item.builtin" size="x-small" class="ml-1">{{
              t('rolesPage.builtin')
            }}</v-chip>
          </div>
        </template>
        <template #[`item.permissions`]="{ item }">
          <v-chip
            v-for="p in item.permissions"
            :key="p"
            size="x-small"
            variant="tonal"
            :color="isPlatform(p) ? 'warning' : undefined"
            class="mr-1 my-1"
            >{{ p }}</v-chip
          >
        </template>
        <template #[`item.users`]="{ item }">
          <span v-if="item.users.length">{{ item.users.join(', ') }}</span>
          <span v-else class="text-medium-emphasis">{{ t('rolesPage.unused') }}</span>
        </template>
        <template #[`item.actions`]="{ item }">
          <div class="d-inline-flex text-no-wrap">
            <v-btn
              icon="mdi-content-copy"
              variant="text"
              size="small"
              :title="t('rolesPage.copy')"
              :aria-label="t('rolesPage.copy')"
              :data-testid="`role-copy-${item.name}`"
              @click="open('create', item, true)"
            />
            <v-btn
              v-if="!item.builtin"
              icon="mdi-pencil"
              variant="text"
              size="small"
              :title="t('rolesPage.edit')"
              :aria-label="t('rolesPage.edit')"
              :data-testid="`role-edit-${item.name}`"
              @click="open('edit', item)"
            />
            <v-btn
              v-if="!item.builtin"
              icon="mdi-delete"
              variant="text"
              size="small"
              color="error"
              :title="t('common.delete')"
              :aria-label="t('common.delete')"
              :disabled="item.users.length > 0"
              :data-testid="`role-delete-${item.name}`"
              @click="open('delete', item)"
            />
          </div>
        </template>
      </v-data-table>
    </v-card>

    <v-dialog :model-value="dialog !== null" max-width="720" @update:model-value="dialog = null">
      <v-card v-if="dialog">
        <v-card-title class="pt-4 px-6">
          <template v-if="dialog === 'create'">{{ t('rolesPage.add') }}</template>
          <template v-else-if="dialog === 'edit'">
            {{ t('rolesPage.editTitle', { name: target?.name }) }}
          </template>
          <template v-else>{{ t('rolesPage.deleteTitle', { name: target?.name }) }}</template>
        </v-card-title>
        <v-card-text>
          <p v-if="dialog === 'delete'">{{ t('rolesPage.deleteText') }}</p>
          <v-form v-else v-model="valid" @submit.prevent="confirm">
            <v-text-field
              v-if="dialog === 'create'"
              v-model="form.name"
              :label="t('rolesPage.name')"
              :rules="[zodRule(RoleNameSchema)]"
              :error-messages="fieldErrors(serverFieldErrors, 'name')"
              data-testid="role-name"
            >
              <template #append-inner>
                <FieldHelp :text="t('rolesPage.nameHint')" />
              </template>
            </v-text-field>
            <v-text-field
              v-model="form.displayName"
              :label="t('rolesPage.displayName')"
              :rules="[(v: string) => !!v.trim() || t('rolesPage.displayName')]"
              :error-messages="fieldErrors(serverFieldErrors, 'displayName')"
              data-testid="role-display-name"
            />
            <v-text-field
              v-model="form.description"
              :label="t('rolesPage.description')"
              class="mb-2"
            />
            <div class="text-title-small mb-1">
              {{ t('rolesPage.permissions') }}
              <FieldHelp :text="t('rolesPage.permissionsHint')" />
            </div>
            <div v-for="g in PERMISSION_GROUPS" :key="g.group" class="mb-2">
              <div class="text-body-small font-weight-medium text-uppercase mt-2">
                {{ t(`permissions.groups.${g.group}`) }}
              </div>
              <v-checkbox
                v-for="p in g.permissions"
                :key="p"
                v-model="form.permissions"
                :value="p"
                :disabled="p === 'view'"
                density="compact"
                hide-details
                :data-testid="`permission-${p}`"
              >
                <template #label>
                  <div>
                    <code>{{ p }}</code>
                    <v-chip
                      v-if="isPlatform(p)"
                      size="x-small"
                      color="warning"
                      variant="tonal"
                      class="ml-1"
                      >{{ t('rolesPage.platform') }}</v-chip
                    >
                    <div class="text-body-small text-medium-emphasis">
                      {{ t(`permissions.${p.replace('.', '_')}`) }}
                    </div>
                  </div>
                </template>
              </v-checkbox>
            </div>
            <p class="text-body-small text-medium-emphasis mt-3">
              {{ t('rolesPage.learn', { name: form.name || '…' }) }}
            </p>
          </v-form>
          <ErrorAlert v-if="dialogError" :error="dialogError" class="mt-4" />
        </v-card-text>
        <v-card-actions class="px-6 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="dialog = null">{{ t('common.cancel') }}</v-btn>
          <v-btn
            :color="dialog === 'delete' ? 'error' : 'primary'"
            variant="flat"
            :loading="busy"
            :disabled="dialog !== 'delete' && !valid"
            data-testid="role-confirm"
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
  </v-container>
</template>
