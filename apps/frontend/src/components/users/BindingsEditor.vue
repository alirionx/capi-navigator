<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { isScopable, type RoleBinding, type RoleInfo } from '@capi-navigator/shared';

/**
 * Role assignments of a user (FP19-F-03, FP19-F-09): role plus optional limits to connections
 * and namespaces. Warns when a limited assignment carries platform permissions; the backend
 * refuses those anyway.
 */
const props = defineProps<{ roles: RoleInfo[]; connections: string[] }>();
const bindings = defineModel<RoleBinding[]>({ required: true });
const { t } = useI18n();

const roleItems = computed(() =>
  props.roles.map((r) => ({
    title: r.builtin ? t(`roles.${r.name}`) : r.displayName,
    value: r.name,
  })),
);

function platformPermissions(b: RoleBinding): string[] {
  if (!b.connections && !b.namespaces) return [];
  const role = props.roles.find((r) => r.name === b.role);
  return (role?.permissions ?? []).filter((p) => p !== 'view' && !isScopable(p));
}

/** Empty lists mean "no limit" and are stored as absent fields. */
function update(i: number, patch: Partial<RoleBinding>): void {
  const next = { ...bindings.value[i]!, ...patch };
  if (next.connections?.length === 0) delete next.connections;
  if (next.namespaces?.length === 0) delete next.namespaces;
  bindings.value = bindings.value.map((b, j) => (j === i ? next : b));
}
const add = () => (bindings.value = [...bindings.value, { role: 'viewer' }]);
const remove = (i: number) => (bindings.value = bindings.value.filter((_, j) => j !== i));
</script>

<template>
  <div data-testid="bindings-editor">
    <v-card
      v-for="(b, i) in bindings"
      :key="i"
      border
      flat
      class="pa-3 mb-2"
      :data-testid="`binding-${i}`"
    >
      <div class="d-flex align-start ga-2">
        <v-select
          :model-value="b.role"
          :items="roleItems"
          :label="t('bindings.role')"
          density="compact"
          hide-details
          :data-testid="`binding-${i}-role`"
          @update:model-value="(role: string) => update(i, { role })"
        />
        <v-btn
          icon="mdi-close"
          variant="text"
          size="small"
          :aria-label="t('bindings.remove')"
          :title="t('bindings.remove')"
          @click="remove(i)"
        />
      </div>
      <v-combobox
        :model-value="b.connections ?? []"
        :items="connections"
        :label="t('bindings.connections')"
        :placeholder="t('bindings.allConnections')"
        persistent-placeholder
        hide-details
        multiple
        chips
        closable-chips
        density="compact"
        class="mt-3"
        :data-testid="`binding-${i}-connections`"
        @update:model-value="(v: string[]) => update(i, { connections: v })"
      />
      <v-combobox
        :model-value="b.namespaces ?? []"
        :label="t('bindings.namespaces')"
        :placeholder="t('bindings.allNamespaces')"
        persistent-placeholder
        hide-details
        multiple
        chips
        closable-chips
        density="compact"
        class="mt-3"
        :data-testid="`binding-${i}-namespaces`"
        @update:model-value="(v: string[]) => update(i, { namespaces: v })"
      />
      <v-alert
        v-if="platformPermissions(b).length"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-3"
      >
        {{ t('bindings.platformLimited', { permissions: platformPermissions(b).join(', ') }) }}
      </v-alert>
    </v-card>
    <v-btn variant="text" prepend-icon="mdi-plus" data-testid="binding-add" @click="add">
      {{ t('bindings.add') }}
    </v-btn>
  </div>
</template>
