<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  PASSWORD_MIN_LENGTH,
  PasswordSchema,
  UsernameSchema,
  type RoleBinding,
  type User,
} from '@capi-navigator/shared';
import { ApiError } from '../api/client.js';
import ErrorAlert from '../components/ErrorAlert.vue';
import BindingsEditor from '../components/users/BindingsEditor.vue';
import { fieldErrors, zodRule } from '../forms/zod-rules.js';
import { useAuthStore } from '../stores/auth.js';
import { useConnectionsStore } from '../stores/connections.js';
import { useRolesStore } from '../stores/roles.js';
import { useUsersStore } from '../stores/users.js';

const { t } = useI18n();
const store = useUsersStore();
const auth = useAuthStore();
const roles = useRolesStore();
const connections = useConnectionsStore();
const connectionNames = computed(() => connections.connections.map((c) => c.name));

const loadError = ref<unknown>(null);
const headers = computed(() => [
  { title: t('users.username'), key: 'username' },
  { title: t('users.bindings'), key: 'bindings', sortable: false },
  { title: t('users.status'), key: 'status', sortable: false },
  { title: t('users.actions'), key: 'actions', sortable: false, align: 'end' as const },
]);

async function reload(): Promise<void> {
  loadError.value = null;
  try {
    await Promise.all([store.load(), roles.load()]);
  } catch (err) {
    loadError.value = err;
  }
}
onMounted(reload);

const isSelf = (u: User) => u.username === auth.me?.username;

/** Short text of an assignment, e.g. "Operator · home / team-a, team-b". */
function bindingLabel(b: RoleBinding): string {
  const role = roles.roles.find((r) => r.name === b.role);
  const name = role?.builtin ? t(`roles.${b.role}`) : (role?.displayName ?? b.role);
  const where = [b.connections?.join(', '), b.namespaces?.join(', ')].filter(Boolean).join(' / ');
  return `${name} · ${where || t('users.everywhere')}`;
}

// Dialog state: one dialog at a time.
type DialogKind = 'create' | 'edit' | 'reset' | 'delete';
const dialog = ref<DialogKind | null>(null);
const target = ref<User | null>(null);
const busy = ref(false);
const dialogError = ref<unknown>(null);
const valid = ref(false);

const form = ref({
  username: '',
  bindings: [{ role: 'viewer' }] as RoleBinding[],
  password: '',
  disabled: false,
});
const serverFieldErrors = computed(() =>
  dialogError.value instanceof ApiError ? dialogError.value.fieldErrors : undefined,
);

function open(kind: DialogKind, user?: User): void {
  target.value = user ?? null;
  dialogError.value = null;
  form.value = {
    username: user?.username ?? '',
    // Plain copy: the store's users are reactive proxies (structuredClone cannot copy them).
    bindings: JSON.parse(JSON.stringify(user?.bindings ?? [{ role: 'viewer' }])) as RoleBinding[],
    password: '',
    disabled: user?.disabled ?? false,
  };
  dialog.value = kind;
}

async function confirm(): Promise<void> {
  busy.value = true;
  dialogError.value = null;
  try {
    const name = target.value?.username ?? '';
    switch (dialog.value) {
      case 'create':
        await store.create({
          username: form.value.username,
          bindings: form.value.bindings,
          password: form.value.password,
        });
        break;
      case 'edit':
        await store.update(name, {
          bindings: form.value.bindings,
          disabled: form.value.disabled,
        });
        break;
      case 'reset':
        await store.resetPassword(name, form.value.password);
        break;
      case 'delete':
        await store.remove(name);
        break;
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
  <v-container>
    <div class="d-flex align-center mb-4">
      <div>
        <h1 class="page-title">{{ t('users.title') }}</h1>
        <p class="text-body-2 text-medium-emphasis mt-1">{{ t('users.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-account-plus" @click="open('create')">
        {{ t('users.add') }}
      </v-btn>
    </div>

    <ErrorAlert v-if="loadError" :error="loadError" class="mb-4" />

    <v-card border class="table-card">
      <v-data-table
        :headers="headers"
        :items="store.users"
        :loading="store.loading"
        item-value="username"
        :no-data-text="t('users.empty')"
        data-testid="users-table"
      >
        <template #[`item.username`]="{ item }">
          {{ item.username }}
          <v-chip v-if="isSelf(item)" size="x-small" class="ml-1">{{ t('users.you') }}</v-chip>
        </template>
        <template #[`item.bindings`]="{ item }">
          <v-chip
            v-for="(b, i) in item.bindings"
            :key="i"
            size="small"
            variant="tonal"
            class="mr-1 my-1"
            >{{ bindingLabel(b) }}</v-chip
          >
          <span v-if="!item.bindings.length" class="text-medium-emphasis">{{
            t('users.noBindings')
          }}</span>
        </template>
        <template #[`item.status`]="{ item }">
          <v-chip
            size="small"
            :color="item.disabled ? 'error' : 'success'"
            variant="tonal"
            class="mr-1"
          >
            {{ item.disabled ? t('users.disabled') : t('users.enabled') }}
          </v-chip>
          <v-chip v-if="item.mustChangePassword" size="small" color="warning" variant="tonal">
            {{ t('users.mustChange') }}
          </v-chip>
        </template>
        <template #[`item.actions`]="{ item }">
          <v-btn
            icon="mdi-pencil"
            variant="text"
            size="small"
            :title="t('users.edit')"
            :aria-label="t('users.edit')"
            :disabled="isSelf(item)"
            @click="open('edit', item)"
          />
          <v-btn
            icon="mdi-lock-reset"
            variant="text"
            size="small"
            :title="t('users.resetPassword')"
            :aria-label="t('users.resetPassword')"
            @click="open('reset', item)"
          />
          <v-btn
            icon="mdi-delete"
            variant="text"
            size="small"
            color="error"
            :title="t('common.delete')"
            :aria-label="t('common.delete')"
            :disabled="isSelf(item)"
            @click="open('delete', item)"
          />
        </template>
      </v-data-table>
    </v-card>

    <v-dialog :model-value="dialog !== null" max-width="640" @update:model-value="dialog = null">
      <v-card v-if="dialog">
        <v-card-title class="pt-4 px-6">
          <template v-if="dialog === 'create'">{{ t('users.add') }}</template>
          <template v-else-if="dialog === 'edit'">
            {{ t('users.editTitle', { username: target?.username }) }}
          </template>
          <template v-else-if="dialog === 'reset'">
            {{ t('users.resetTitle', { username: target?.username }) }}
          </template>
          <template v-else>{{ t('users.deleteTitle', { username: target?.username }) }}</template>
        </v-card-title>
        <v-card-text>
          <v-form v-model="valid" @submit.prevent="confirm">
            <v-text-field
              v-if="dialog === 'create'"
              v-model="form.username"
              :label="t('users.username')"
              :rules="[zodRule(UsernameSchema)]"
              :hint="t('users.usernameHint')"
              persistent-hint
              :error-messages="fieldErrors(serverFieldErrors, 'username')"
              class="mb-2"
              name="username"
            />
            <template v-if="dialog === 'create' || dialog === 'edit'">
              <div class="text-subtitle-2 mt-2">{{ t('users.bindings') }}</div>
              <p class="text-caption text-medium-emphasis mb-2">{{ t('users.bindingsHint') }}</p>
              <BindingsEditor
                v-model="form.bindings"
                :roles="roles.roles"
                :connections="connectionNames"
                class="mb-2"
              />
            </template>
            <v-switch
              v-if="dialog === 'edit'"
              v-model="form.disabled"
              :label="t('users.disabledLabel')"
              :hint="t('users.disabledHint')"
              persistent-hint
              color="error"
              class="mb-2"
            />
            <v-text-field
              v-if="dialog === 'create' || dialog === 'reset'"
              v-model="form.password"
              :label="t('users.password')"
              type="password"
              autocomplete="new-password"
              :rules="[zodRule(PasswordSchema)]"
              :hint="
                dialog === 'create'
                  ? t('users.passwordHint', { min: PASSWORD_MIN_LENGTH })
                  : t('users.resetHint', { min: PASSWORD_MIN_LENGTH })
              "
              persistent-hint
              :error-messages="fieldErrors(serverFieldErrors, 'password')"
              name="password"
            />
            <p v-if="dialog === 'delete'">{{ t('users.deleteText') }}</p>
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
            :disabled="dialog !== 'delete' && !valid"
            data-testid="dialog-confirm"
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
