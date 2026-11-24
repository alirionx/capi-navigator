<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ErrorAlert from '../ErrorAlert.vue';

/** Ending the access (FP36-F-04) and deleting a namespace (FP36-F-05), with the name typed. */
const props = defineProps<{
  name: string;
  title: string;
  text: string;
  confirmLabel: string;
  action: () => Promise<void>;
}>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ done: [] }>();
const { t } = useI18n();
const typed = ref('');
const busy = ref(false);
const error = ref<unknown>(null);
watch(open, () => {
  typed.value = '';
  error.value = null;
});

async function confirm(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await props.action();
    open.value = false;
    emit('done');
  } catch (err) {
    error.value = err;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="560">
    <v-card :title="title" data-testid="confirm-namespace-dialog">
      <v-card-text>
        <v-alert type="warning" variant="tonal" class="mb-3">{{ text }}</v-alert>
        <v-text-field
          v-model="typed"
          :label="t('addons.confirmName', { name })"
          data-testid="confirm-namespace-name"
        />
        <ErrorAlert v-if="error" :error="error" class="mt-3" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">{{ t('common.cancel') }}</v-btn>
        <v-btn
          color="error"
          variant="flat"
          :disabled="typed !== name"
          :loading="busy"
          data-testid="confirm-namespace-apply"
          @click="confirm"
          >{{ confirmLabel }}</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
