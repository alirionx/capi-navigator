<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LookupOption } from '@capi-navigator/shared';

/**
 * Bastion host settings (FP5-F-20), used in the wizard and as day-2 change. OpenStack (CAPO)
 * opens SSH to the bastion to everyone; AWS (CAPA) restricts it to the allowed networks.
 */
export interface BastionDraft {
  enabled: boolean;
  machineSize: string;
  allowedCidrs: string[];
}
const model = defineModel<BastionDraft>({ required: true });
const props = defineProps<{
  provider: 'openstack' | 'aws';
  sizes: LookupOption[];
  hasKeyPair: boolean;
  /** Size cannot change while the bastion runs (day-2). */
  sizeLocked?: boolean;
  /** The credential test found broken Neutron paging links (OpenStack). */
  pagingWarning?: string;
}>();
const { t } = useI18n();

const cidrPattern = /^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/;
const cidrRule = (v: string[]) =>
  (v ?? []).every((c) => cidrPattern.test(c.trim())) || t('bastion.cidrInvalid');
const openToAll = computed(
  () => props.provider === 'aws' && model.value.allowedCidrs.some((c) => c.trim() === '0.0.0.0/0'),
);
</script>

<template>
  <div data-testid="bastion-editor">
    <v-switch
      v-model="model.enabled"
      :label="t('bastion.enable')"
      :hint="t('bastion.enableHint')"
      persistent-hint
      data-testid="bastion-enabled"
    />
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
        v-if="provider === 'openstack'"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-3"
        data-testid="bastion-open-warning"
      >
        {{ t('bastion.openStackOpen') }}
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
            :label="t(`bastion.size.${provider}`)"
            :hint="
              sizeLocked
                ? t('bastion.sizeLocked')
                : t(provider === 'openstack' ? 'bastion.sizeHintOs' : 'bastion.sizeHintAws')
            "
            persistent-hint
            :rules="[(v: string) => provider !== 'openstack' || !!v || t('wizard.required')]"
            data-testid="bastion-size"
          />
        </v-col>
        <v-col v-if="provider === 'aws'" cols="12" md="7">
          <v-combobox
            v-model="model.allowedCidrs"
            multiple
            chips
            closable-chips
            :label="t('bastion.cidrs')"
            :hint="t('bastion.cidrsHint')"
            persistent-hint
            :rules="[(v: string[]) => (v ?? []).length > 0 || t('bastion.cidrsRequired'), cidrRule]"
            data-testid="bastion-cidrs"
          />
          <v-alert v-if="openToAll" type="warning" variant="tonal" density="compact" class="mt-2">
            {{ t('bastion.openWarning') }}
          </v-alert>
        </v-col>
      </v-row>
    </template>
  </div>
</template>
