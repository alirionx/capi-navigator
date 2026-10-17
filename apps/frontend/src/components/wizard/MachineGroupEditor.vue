<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LookupOption } from '@capi-navigator/shared';

/** Machine size, root volume and image override of one group (FP-5 step 2). */
interface Group {
  machineSize: string;
  image?: string;
  rootVolumeSizeGB?: number;
}
const group = defineModel<Group>({ required: true });
const props = defineProps<{
  provider: 'openstack' | 'aws';
  sizes: LookupOption[];
  images: LookupOption[];
  sizesLoading?: boolean;
  role: 'control-plane' | 'worker';
}>();
const { t } = useI18n();

const selected = computed(() => props.sizes.find((s) => s.value === group.value.machineSize));
/** OpenStack flavors without local disk (e.g. Infomaniak "-disk0") need a root volume. */
const needsVolume = computed(
  () => props.provider === 'openstack' && selected.value?.details?.diskGB === 0,
);

watch(needsVolume, (need) => {
  if (need && !group.value.rootVolumeSizeGB) group.value.rootVolumeSizeGB = 50;
  if (!need && props.provider === 'openstack') group.value.rootVolumeSizeGB = undefined;
});

const target = computed(() =>
  props.provider === 'openstack' ? 'OpenStackMachineTemplate' : 'AWSMachineTemplate',
);
const sizeField = computed(() =>
  props.provider === 'openstack' ? 'flavor.filter.name' : 'instanceType',
);
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
    <v-text-field
      v-if="needsVolume || provider === 'aws'"
      v-model.number="group.rootVolumeSizeGB"
      type="number"
      :label="t('wizard.rootVolume')"
      :hint="needsVolume ? t('wizard.rootVolumeNeeded') : t('wizard.rootVolumeHint', { def: 50 })"
      persistent-hint
      :rules="[
        (v: number | undefined) => !needsVolume || (!!v && v >= 10) || t('wizard.rootVolumeMin'),
      ]"
      suffix="GB"
      style="max-width: 200px"
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
</template>
