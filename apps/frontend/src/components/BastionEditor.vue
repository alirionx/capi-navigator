<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { INFRA_PLUGINS, type Infrastructure, type LookupOption } from '@capi-navigator/shared';
import FieldHelp from './FieldHelp.vue';

/**
 * Bastion host settings (FP5-F-20), used in the wizard and as day-2 change. The provider's form
 * description says whether SSH is restricted to source networks or open to everyone (FP25-F-05).
 */
export interface BastionDraft {
  enabled: boolean;
  machineSize: string;
  allowedCidrs: string[];
}
const model = defineModel<BastionDraft>({ required: true });
const props = defineProps<{
  provider: Infrastructure['provider'];
  sizes: LookupOption[];
  hasKeyPair: boolean;
  /** Size cannot change while the bastion runs (day-2). */
  sizeLocked?: boolean;
  /** A failed credential test check that breaks the bastion (OpenStack: Neutron paging). */
  pagingWarning?: string;
}>();
const { t } = useI18n();

const form = computed(() => INFRA_PLUGINS[props.provider].form.bastion);
const cidrPattern = /^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/;
const cidrRule = (v: string[]) =>
  (v ?? []).every((c) => cidrPattern.test(c.trim())) || t('bastion.cidrInvalid');
const openToAll = computed(
  () =>
    !!form.value?.allowedCidrs && model.value.allowedCidrs.some((c) => c.trim() === '0.0.0.0/0'),
);
</script>

<template>
  <div data-testid="bastion-editor">
    <v-switch v-model="model.enabled" data-testid="bastion-enabled">
      <template #label>
        {{ t('bastion.enable') }}
        <FieldHelp :text="t('bastion.enableHint')" />
      </template>
    </v-switch>
    <template v-if="model.enabled">
      <v-alert v-if="!hasKeyPair" type="error" variant="tonal" density="compact" class="mt-3">
        {{ t('bastion.needsKeyPair') }}
      </v-alert>
      <v-alert
        v-if="pagingWarning"
        type="error"
        variant="tonal"
        density="compact"
        class="mt-3"
        data-testid="bastion-paging-warning"
      >
        {{ t('bastion.pagingBroken') }} {{ pagingWarning }}
      </v-alert>
      <v-alert
        v-if="form?.openWarning"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-3"
        data-testid="bastion-open-warning"
      >
        {{ t(form.openWarning) }}
      </v-alert>
      <v-row class="mt-1">
        <v-col cols="12" md="5">
          <v-autocomplete
            v-model="model.machineSize"
            :items="sizes"
            item-title="label"
            item-value="value"
            clearable
            :disabled="sizeLocked"
            :label="form ? t(form.sizeLabel) : ''"
            :rules="[(v: string) => !form?.sizeRequired || !!v || t('wizard.required')]"
            data-testid="bastion-size"
          >
            <template #append-inner>
              <FieldHelp
                :text="sizeLocked ? t('bastion.sizeLocked') : form ? t(form.sizeHint) : ''"
              />
            </template>
          </v-autocomplete>
        </v-col>
        <v-col v-if="form?.allowedCidrs" cols="12" md="7">
          <v-combobox
            v-model="model.allowedCidrs"
            multiple
            chips
            closable-chips
            :label="t('bastion.cidrs')"
            :rules="[(v: string[]) => (v ?? []).length > 0 || t('bastion.cidrsRequired'), cidrRule]"
            data-testid="bastion-cidrs"
          >
            <template #append-inner>
              <FieldHelp :text="t('bastion.cidrsHint')" />
            </template>
          </v-combobox>
          <v-alert v-if="openToAll" type="warning" variant="tonal" density="compact" class="mt-2">
            {{ t('bastion.openWarning') }}
          </v-alert>
        </v-col>
      </v-row>
    </template>
  </div>
</template>
