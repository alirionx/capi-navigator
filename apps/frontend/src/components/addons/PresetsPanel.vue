<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AddonPresetView } from '@capi-navigator/shared';
import ChangeDialog from '../ChangeDialog.vue';
import ErrorAlert from '../ErrorAlert.vue';
import ValuesEditor from './ValuesEditor.vue';
import { useAuthStore } from '../../stores/auth.js';
import { useHelmRepositoriesStore } from '../../stores/helm-repositories.js';

/**
 * CCM/CSI presets (FP8-F-14): defaults from the app, overrides by admins. New clusters use the
 * override right away; namespaces with an older preset are updated after a preview.
 */
const props = defineProps<{ connection: string }>();
const { t } = useI18n();
const auth = useAuthStore();
const repos = useHelmRepositoriesStore();
const isAdmin = computed(() => auth.can('presets.manage'));

const presets = ref<AddonPresetView[]>([]);
const error = ref<unknown>(null);
async function load(): Promise<void> {
  error.value = null;
  try {
    presets.value = await repos.presets(props.connection);
  } catch (err) {
    error.value = err;
  }
}
watch(() => props.connection, load, { immediate: true });

const editing = ref<AddonPresetView | null>(null);
const editOpen = ref(false);
const version = ref('');
const values = ref('');
const saving = ref(false);
const saveError = ref<unknown>(null);
function edit(p: AddonPresetView): void {
  editing.value = p;
  version.value = p.effective.version;
  values.value = p.effective.valuesTemplate;
  saveError.value = null;
  editOpen.value = true;
}
async function save(reset = false): Promise<void> {
  const p = editing.value!;
  saving.value = true;
  saveError.value = null;
  try {
    const override = reset
      ? null
      : {
          ...(version.value.trim() !== p.defaults.version ? { version: version.value.trim() } : {}),
          ...(values.value !== p.defaults.valuesTemplate ? { valuesTemplate: values.value } : {}),
        };
    await repos.setPresetOverride(p.id, override && Object.keys(override).length ? override : null);
    editOpen.value = false;
    await load();
  } catch (err) {
    saveError.value = err;
  } finally {
    saving.value = false;
  }
}

const rollout = ref<AddonPresetView | null>(null);
const rolloutOpen = ref(false);
const outdated = (p: AddonPresetView) => p.namespaces.filter((n) => !n.upToDate);
</script>

<template>
  <v-card border data-testid="addon-presets">
    <v-card-item :title="t('presets.title')" :subtitle="t('presets.subtitle')" />
    <v-card-text>
      <ErrorAlert v-if="error" :error="error" />
      <v-table density="compact">
        <thead>
          <tr>
            <th>{{ t('presets.preset') }}</th>
            <th>{{ t('addons.chart') }}</th>
            <th>{{ t('addons.version') }}</th>
            <th>{{ t('presets.namespaces') }}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in presets" :key="p.id" :data-testid="`preset-${p.id}`">
            <td>
              <div class="font-weight-medium">{{ p.displayName }}</div>
              <div class="text-caption text-medium-emphasis">{{ p.provider }} · {{ p.kind }}</div>
            </td>
            <td class="text-caption">{{ p.chartName }}<br />{{ p.repoURL }}</td>
            <td>
              {{ p.effective.version }}
              <v-chip
                v-if="p.override"
                size="x-small"
                color="primary"
                variant="tonal"
                class="ml-1"
                >{{ t('presets.customized') }}</v-chip
              >
              <div v-if="p.override" class="text-caption text-medium-emphasis">
                {{ t('presets.default', { version: p.defaults.version }) }}
              </div>
            </td>
            <td>
              <v-chip
                v-for="n in p.namespaces"
                :key="n.namespace"
                size="x-small"
                variant="tonal"
                class="mr-1 mb-1"
                :color="n.upToDate ? 'success' : n.managedByApp ? 'warning' : 'grey'"
                :title="
                  n.upToDate
                    ? t('presets.upToDate')
                    : n.managedByApp
                      ? t('presets.outdated')
                      : t('presets.external')
                "
                >{{ n.namespace }} ({{ n.clusters }})</v-chip
              >
              <span v-if="!p.namespaces.length" class="text-caption text-medium-emphasis">–</span>
            </td>
            <td class="text-right text-no-wrap">
              <v-btn
                v-if="isAdmin && outdated(p).some((n) => n.managedByApp)"
                size="small"
                variant="text"
                color="warning"
                prepend-icon="mdi-upload"
                :data-testid="`preset-rollout-${p.id}`"
                @click="
                  rollout = p;
                  rolloutOpen = true;
                "
                >{{ t('presets.rollout') }}</v-btn
              >
              <v-btn
                v-if="isAdmin"
                size="small"
                variant="text"
                prepend-icon="mdi-pencil"
                :data-testid="`preset-edit-${p.id}`"
                @click="edit(p)"
                >{{ t('presets.edit') }}</v-btn
              >
            </td>
          </tr>
        </tbody>
      </v-table>
    </v-card-text>

    <v-dialog v-model="editOpen" max-width="900" scrollable>
      <v-card v-if="editing" :title="t('presets.editTitle', { name: editing.displayName })">
        <v-card-text>
          <v-alert type="info" variant="tonal" density="compact" class="mb-3">{{
            t('presets.editInfo')
          }}</v-alert>
          <v-text-field
            v-model="version"
            :label="t('addons.version')"
            :hint="t('presets.versionHint', { version: editing.defaults.version })"
            persistent-hint
            class="mb-3"
            data-testid="preset-version"
          />
          <div class="text-subtitle-2 mb-1">{{ t('addons.values') }}</div>
          <ValuesEditor v-model="values" height="320px" />
          <ErrorAlert v-if="saveError" :error="saveError" class="mt-3" />
        </v-card-text>
        <v-card-actions>
          <v-btn v-if="editing.override" color="warning" :loading="saving" @click="save(true)">{{
            t('presets.reset')
          }}</v-btn>
          <v-spacer />
          <v-btn @click="editOpen = false">{{ t('common.cancel') }}</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="saving"
            :disabled="!version.trim()"
            data-testid="preset-save"
            @click="save()"
            >{{ t('common.save') }}</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>

    <ChangeDialog
      v-if="rollout"
      v-model="rolloutOpen"
      :title="t('presets.rolloutTitle', { name: rollout.displayName })"
      :valid="true"
      :preview="() => repos.presetRolloutPreview(connection, rollout!.id)"
      :apply="() => repos.presetRollout(connection, rollout!.id)"
      @applied="load"
    >
      <p class="text-body-2">
        {{
          t('presets.rolloutText', {
            version: rollout.effective.version,
            namespaces: outdated(rollout)
              .filter((n) => n.managedByApp)
              .map((n) => n.namespace)
              .join(', '),
          })
        }}
      </p>
    </ChangeDialog>
  </v-card>
</template>
