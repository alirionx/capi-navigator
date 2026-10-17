<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LookupOption } from '@capi-navigator/shared';

/** Machine size, root disk and image override of one group (FP-5 step 2, FP5-F-19). */
interface Group {
  machineSize: string;
  image?: string;
  rootVolumeSizeGB?: number;
  rootVolumeType?: string;
}
const group = defineModel<Group>({ required: true });
const props = defineProps<{
  provider: 'openstack' | 'aws';
  sizes: LookupOption[];
  images: LookupOption[];
  volumeTypes: LookupOption[];
  sizesLoading?: boolean;
  role: 'control-plane' | 'worker';
  /** Root disk mirrored from the control plane ("same root disk for all groups"). */
  rootDiskLocked?: boolean;
}>();
const { t } = useI18n();

const selected = computed(() => props.sizes.find((s) => s.value === group.value.machineSize));
/** OpenStack flavors without local disk (e.g. Infomaniak "-disk0") need a root volume. */
const needsVolume = computed(
  () => props.provider === 'openstack' && selected.value?.details?.diskGB === 0,
);

watch(needsVolume, (need) => {
  if (need && !group.value.rootVolumeSizeGB && !props.rootDiskLocked)
    group.value.rootVolumeSizeGB = 50;
});
// An OpenStack volume type needs a size (validated in the spec as well).
watch(
  () => group.value.rootVolumeSizeGB,
  (size) => {
    if (!size && props.provider === 'openstack') group.value.rootVolumeType = undefined;
  },
);

const target = computed(() =>
  props.provider === 'openstack' ? 'OpenStackMachineTemplate' : 'AWSMachineTemplate',
);
const sizeField = computed(() =>
  props.provider === 'openstack' ? 'flavor.filter.name' : 'instanceType',
);
const rootHint = computed(() => {
  if (props.rootDiskLocked) return t('wizard.rootDiskLocked');
  if (props.provider === 'aws')
    return t('wizard.rootVolumeHint', { def: 50, target: target.value });
  if (needsVolume.value) return t('wizard.rootVolumeNeeded', { target: target.value });
  return t('wizard.rootVolumeLocal', {
    size: selected.value ? ` (${selected.value.details?.diskGB} GB)` : '',
    target: target.value,
  });
});
const rootRules = [
  (v: number | undefined | '') =>
    !needsVolume.value || (!!v && v >= 10) || t('wizard.rootVolumeMin'),
  (v: number | undefined | '') => !v || v >= 10 || t('wizard.rootVolumeMin'),
  (v: number | undefined | '') => !v || v <= 4000 || t('wizard.rootVolumeMax'),
];
</script>

<template>
  <div class="d-flex flex-wrap ga-3">
    <v-autocomplete
      v-model="group.machineSize"
      :items="sizes"
      item-title="label"
      item-value="value"
      :loading="sizesLoading"
      :label="t(`wizard.machineSize.${provider}`)"
      :hint="t('wizard.machineSizeHint', { target, field: sizeField })"
      persistent-hint
      :rules="[(v: string) => !!v || t('wizard.required')]"
      style="min-width: 320px; flex: 2"
      :data-testid="`size-${role}`"
    />
    <v-autocomplete
      v-model="group.image"
      :items="images"
      item-title="label"
      item-value="value"
      clearable
      :label="t('wizard.imageOverride')"
      :hint="t('wizard.imageOverrideHint')"
      persistent-hint
      style="min-width: 260px; flex: 1"
    />
  </div>
  <div class="d-flex flex-wrap ga-3 mt-3">
    <v-text-field
      :model-value="group.rootVolumeSizeGB"
      type="number"
      min="10"
      max="4000"
      :label="t('wizard.rootVolume')"
      :placeholder="provider === 'aws' ? '50' : undefined"
      :hint="rootHint"
      persistent-hint
      :rules="rootRules"
      :disabled="rootDiskLocked"
      :clearable="provider === 'openstack' && !needsVolume"
      suffix="GB"
      style="min-width: 260px; flex: 2"
      :data-testid="`root-size-${role}`"
      @update:model-value="
        (v: string | number | null) =>
          (group.rootVolumeSizeGB = v === '' || v === null ? undefined : Number(v))
      "
    />
    <v-select
      v-model="group.rootVolumeType"
      :items="volumeTypes"
      item-title="label"
      item-value="value"
      clearable
      :label="t('wizard.rootVolumeType')"
      :placeholder="provider === 'aws' ? 'gp3' : undefined"
      :hint="
        rootDiskLocked
          ? t('wizard.rootDiskLocked')
          : t(provider === 'aws' ? 'wizard.rootVolumeTypeAws' : 'wizard.rootVolumeTypeOpenStack')
      "
      persistent-hint
      :disabled="rootDiskLocked || (provider === 'openstack' && !group.rootVolumeSizeGB)"
      style="min-width: 220px; flex: 1"
      :data-testid="`root-type-${role}`"
    />
  </div>
</template>
