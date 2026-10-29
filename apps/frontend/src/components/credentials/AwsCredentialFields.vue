<script setup lang="ts">
import { ref, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { AwsCredentialInputSchema, type Credential } from '@capi-navigator/shared';
import { fieldErrors, zodRule } from '../../forms/zod-rules.js';
import FieldHelp from '../FieldHelp.vue';

/** Secret part of AWS credentials: access key of an IAM user (FP4-F-07). */
const input = defineModel<unknown>({ required: true });
const props = defineProps<{
  credential?: Credential | null;
  serverFieldErrors?: Record<string, string[]>;
}>();
const { t } = useI18n();
const awsShape = AwsCredentialInputSchema.shape;

const accessKeyId = ref('');
const secretAccessKey = ref('');
const awsRegion = ref(props.credential?.summary.region ?? 'eu-central-1');

watchEffect(() => {
  input.value = {
    accessKeyId: accessKeyId.value.trim(),
    secretAccessKey: secretAccessKey.value.trim(),
    region: awsRegion.value.trim(),
  };
});
</script>

<template>
  <div>
    <v-alert type="info" variant="tonal" density="compact" class="mb-3">{{
      t('credentials.aws.recommendIamUser')
    }}</v-alert>
    <v-text-field
      v-model="accessKeyId"
      :label="t('credentials.aws.accessKeyId')"
      :rules="[zodRule(awsShape.accessKeyId)]"
      autocomplete="off"
      :error-messages="fieldErrors(serverFieldErrors, 'aws.accessKeyId')"
      name="accessKeyId"
    />
    <v-text-field
      v-model="secretAccessKey"
      :label="t('credentials.aws.secretAccessKey')"
      :rules="[zodRule(awsShape.secretAccessKey)]"
      type="password"
      autocomplete="off"
      name="secretAccessKey"
    />
    <v-text-field
      v-model="awsRegion"
      :label="t('credentials.aws.region')"
      :rules="[zodRule(awsShape.region)]"
      name="region"
    >
      <template #append-inner>
        <FieldHelp :text="t('credentials.aws.regionHint')" />
      </template>
    </v-text-field>
  </div>
</template>
