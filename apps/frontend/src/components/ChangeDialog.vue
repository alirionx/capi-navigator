<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ClusterChangePreview } from '@capi-navigator/shared';

/** Previews of cluster changes and of add-ons (FP-8): rollouts only for clusters. */
type ChangePreview = Omit<ClusterChangePreview, 'rollouts'> &
  Partial<Pick<ClusterChangePreview, 'rollouts'>>;
import ErrorAlert from './ErrorAlert.vue';
import MissingArtifacts from './MissingArtifacts.vue';
import YamlDiff from './YamlDiff.vue';

/**
 * Spec change with preview (hard rules 4 and 6): a form in the default slot, then the diff of
 * the objects that change, drift reported by server-side apply, and apply after confirmation.
 */
const props = defineProps<{
  title: string;
  /** False while the form is invalid. */
  valid: boolean;
  preview: () => Promise<ChangePreview>;
  apply: (takeOver: boolean) => Promise<unknown>;
  /** Width of the form step (wider for forms with an editor). */
  formWidth?: number;
}>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ applied: [] }>();
const { t } = useI18n();

const step = ref<'form' | 'preview'>('form');
const result = ref<ChangePreview | null>(null);
const error = ref<unknown>(null);
const busy = ref(false);
const takeOver = ref(false);
const panel = ref<number[]>([0]);

watch(open, (o) => {
  if (o) {
    step.value = 'form';
    result.value = null;
    error.value = null;
    takeOver.value = false;
  }
});

const blockingDrift = computed(() => result.value?.drift.filter((d) => d.blocking) ?? []);
const canApply = computed(
  () =>
    !!result.value &&
    result.value.diffs.length > 0 &&
    result.value.blockers.length === 0 &&
    (blockingDrift.value.length === 0 || takeOver.value),
);

async function showPreview(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    result.value = await props.preview();
    panel.value = [result.value.diffs.length > 1 ? 1 : 0];
    step.value = 'preview';
  } catch (err) {
    error.value = err;
  } finally {
    busy.value = false;
  }
}

async function confirm(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await props.apply(takeOver.value);
    open.value = false;
    emit('applied');
  } catch (err) {
    error.value = err;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" :max-width="step === 'form' ? (formWidth ?? 560) : 1100" scrollable>
    <v-card :title="title" data-testid="change-dialog">
      <v-card-text>
        <div v-show="step === 'form'"><slot /></div>
        <template v-if="step === 'preview' && result">
          <v-alert
            v-for="b in result.blockers"
            :key="b"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-2"
            >{{ b }}</v-alert
          >
          <MissingArtifacts
            v-if="result.missingArtifacts?.length"
            :artifacts="result.missingArtifacts"
            :retry="showPreview"
            class="mb-2"
          />
          <v-alert
            v-for="w in result.warnings"
            :key="w"
            type="info"
            variant="tonal"
            density="compact"
            class="mb-2"
            >{{ w }}</v-alert
          >
          <v-alert
            v-if="blockingDrift.length"
            type="warning"
            variant="tonal"
            class="mb-3"
            data-testid="drift"
          >
            <div class="font-weight-medium mb-1">{{ t('changes.driftTitle') }}</div>
            <div v-for="d in blockingDrift" :key="d.kind + d.name" class="text-body-2">
              {{ d.kind }} {{ d.name }}: {{ d.fields.join(', ') || '–' }} ({{
                d.managers.join(', ')
              }})
            </div>
            <v-checkbox
              v-model="takeOver"
              :label="t('changes.takeOver')"
              class="mt-2"
              data-testid="take-over"
            />
          </v-alert>
          <!-- FP7-F-16: which machines are replaced, in which order -->
          <slot name="preview" :result="result" />
          <v-card v-if="result.rollouts?.length" border class="mb-3" data-testid="rollout-plan">
            <v-card-item :title="t('changes.rolloutTitle')" />
            <v-table density="compact">
              <tbody>
                <tr v-for="r in result.rollouts" :key="r.kind + r.name">
                  <td class="text-no-wrap">
                    <v-chip
                      size="x-small"
                      variant="tonal"
                      :color="
                        r.action === 'remove' ? 'error' : r.action === 'later' ? 'info' : 'warning'
                      "
                      >{{ t(`changes.rollout.${r.action}`) }}</v-chip
                    >
                  </td>
                  <td class="font-weight-medium">{{ r.group }}</td>
                  <td class="text-caption">{{ r.machines.join(', ') || '–' }}</td>
                  <td class="text-caption text-medium-emphasis">{{ r.strategy }}</td>
                </tr>
              </tbody>
            </v-table>
          </v-card>
          <v-alert v-if="result.diffs.length === 0" type="info" variant="tonal">{{
            t('changes.nothing')
          }}</v-alert>
          <p v-else class="text-body-2 text-medium-emphasis mb-2">
            {{ t('changes.summary', { n: result.diffs.length }) }}
          </p>
          <v-expansion-panels v-model="panel" multiple variant="accordion">
            <v-expansion-panel v-for="d in result.diffs" :key="d.kind + d.name">
              <v-expansion-panel-title>
                <v-chip
                  size="x-small"
                  variant="tonal"
                  :color="d.change === 'create' ? 'success' : 'info'"
                  class="mr-2"
                  >{{ t(`changes.${d.change}`) }}</v-chip
                >
                {{ d.kind }} <span class="font-weight-medium ml-1">{{ d.name }}</span>
              </v-expansion-panel-title>
              <v-expansion-panel-text>
                <YamlDiff :before="d.before" :after="d.after" />
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </template>
        <ErrorAlert v-if="error" :error="error" class="mt-3" />
      </v-card-text>
      <v-card-actions>
        <v-btn v-if="step === 'preview'" prepend-icon="mdi-arrow-left" @click="step = 'form'">{{
          t('common.back')
        }}</v-btn>
        <v-spacer />
        <v-btn @click="open = false">{{ t('common.cancel') }}</v-btn>
        <v-btn
          v-if="step === 'form'"
          color="primary"
          variant="flat"
          :disabled="!valid"
          :loading="busy"
          data-testid="change-preview"
          @click="showPreview"
          >{{ t('changes.preview') }}</v-btn
        >
        <v-btn
          v-else
          color="primary"
          variant="flat"
          :disabled="!canApply"
          :loading="busy"
          data-testid="change-apply"
          @click="confirm"
          >{{ t('changes.apply') }}</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
