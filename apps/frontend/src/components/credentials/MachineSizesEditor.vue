<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  DEFAULT_PROXMOX_MACHINE_SIZES,
  ProxmoxMachineSizesSchema,
  type Credential,
  type ProxmoxMachineSize,
} from '@capi-navigator/shared';

/**
 * Machine sizes kept with a credential (FP31-F-04): not secret, so they can be changed without
 * entering the token again. The wizard offers them as machine sizes.
 */
const settings = defineModel<{ machineSizes: ProxmoxMachineSize[] } | null>({ required: true });
const props = defineProps<{ credential?: Credential | null }>();
const { t } = useI18n();

const rows = ref(
  (props.credential?.summary.machineSizes ?? DEFAULT_PROXMOX_MACHINE_SIZES).map((s) => ({
    name: s.name,
    vcpus: s.vcpus,
    memoryGiB: s.memoryMiB / 1024,
  })),
);
const sizes = computed(() =>
  rows.value.map((r) => ({
    name: r.name.trim(),
    vcpus: Number(r.vcpus),
    memoryMiB: Math.round(Number(r.memoryGiB) * 1024),
  })),
);
const check = computed(() => ProxmoxMachineSizesSchema.safeParse(sizes.value));
watchEffect(() => {
  settings.value = check.value.success ? { machineSizes: check.value.data } : null;
});
</script>

<template>
  <div class="mt-4" data-testid="machine-sizes">
    <div class="text-title-small">{{ t('credentials.sizes.title') }}</div>
    <p class="text-body-small text-medium-emphasis mb-2">{{ t('credentials.sizes.hint') }}</p>
    <div v-for="(r, i) in rows" :key="i" class="d-flex ga-2 align-center mb-3">
      <v-text-field
        v-model="r.name"
        :label="t('credentials.sizes.name')"
        density="compact"
        hide-details
        :data-testid="`size-name-${i}`"
      />
      <v-text-field
        v-model.number="r.vcpus"
        :label="t('credentials.sizes.vcpus')"
        type="number"
        min="1"
        density="compact"
        hide-details
        style="max-width: 110px"
      />
      <v-text-field
        v-model.number="r.memoryGiB"
        :label="t('credentials.sizes.memory')"
        type="number"
        min="1"
        step="0.5"
        density="compact"
        hide-details
        style="max-width: 130px"
      />
      <v-btn
        icon="mdi-close"
        size="small"
        variant="text"
        :aria-label="t('common.delete')"
        :disabled="rows.length === 1"
        @click="rows.splice(i, 1)"
      />
    </div>
    <v-btn
      size="small"
      variant="text"
      prepend-icon="mdi-plus"
      @click="rows.push({ name: '', vcpus: 2, memoryGiB: 4 })"
      >{{ t('credentials.sizes.add') }}</v-btn
    >
    <div v-if="!check.success" class="text-body-small text-error mt-1">
      {{ check.error.issues[0]?.message }}
    </div>
  </div>
</template>
