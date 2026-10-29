<script setup lang="ts">
import { computed, ref, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CloudsYamlInfo, Credential } from '@capi-navigator/shared';
import { useCredentialsStore } from '../../stores/credentials.js';
import ErrorAlert from '../ErrorAlert.vue';
import FieldHelp from '../FieldHelp.vue';

/** Secret part of OpenStack credentials: clouds.yaml or a form (FP4-F-01). */
const input = defineModel<unknown>({ required: true });
defineProps<{ credential?: Credential | null; serverFieldErrors?: Record<string, string[]> }>();
const { t } = useI18n();
const store = useCredentialsStore();
const required = (v: string) => !!v?.trim() || t('credentials.required');

const osSource = ref<'clouds.yaml' | 'form'>('clouds.yaml');
const cloudsYaml = ref('');
const cloudsFile = ref<File | File[] | null>(null);
const cloudsInfo = ref<CloudsYamlInfo | null>(null);
const cloudName = ref<string | null>(null);
const cloudsError = ref<unknown>(null);
const authUrl = ref('');
const region = ref('');
const authType = ref<'applicationCredential' | 'password'>('applicationCredential');
const appCredId = ref('');
const appCredSecret = ref('');
const username = ref('');
const password = ref('');
const projectName = ref('');
const cacert = ref('');

watch(cloudsFile, async (f) => {
  const file = Array.isArray(f) ? f[0] : f;
  if (file) cloudsYaml.value = await file.text();
});
let timer: ReturnType<typeof setTimeout> | undefined;
watch(cloudsYaml, (text) => {
  clearTimeout(timer);
  cloudsInfo.value = null;
  cloudsError.value = null;
  if (!text.trim()) return;
  timer = setTimeout(async () => {
    try {
      cloudsInfo.value = await store.cloudsYamlInfo(text);
      cloudName.value = cloudsInfo.value.clouds[0]?.name ?? null;
    } catch (err) {
      cloudsError.value = err;
    }
  }, 400);
});
const cloudItems = computed(
  () =>
    cloudsInfo.value?.clouds.map((c) => ({
      title: `${c.name} — ${c.region ?? '?'} (${c.authType ?? 'password'})`,
      value: c.name,
    })) ?? [],
);

watchEffect(() => {
  const ca = cacert.value.trim() ? { cacert: cacert.value } : {};
  input.value =
    osSource.value === 'clouds.yaml'
      ? {
          source: 'clouds.yaml' as const,
          cloudsYaml: cloudsYaml.value,
          ...(cloudName.value ? { cloudName: cloudName.value } : {}),
          ...ca,
        }
      : {
          source: 'form' as const,
          authUrl: authUrl.value.trim(),
          region: region.value.trim(),
          auth:
            authType.value === 'applicationCredential'
              ? {
                  type: 'applicationCredential' as const,
                  applicationCredentialId: appCredId.value,
                  applicationCredentialSecret: appCredSecret.value,
                }
              : {
                  type: 'password' as const,
                  username: username.value,
                  password: password.value,
                  projectName: projectName.value,
                },
          ...ca,
        };
});
</script>

<template>
  <div>
    <v-btn-toggle
      v-model="osSource"
      mandatory
      color="primary"
      variant="outlined"
      density="comfortable"
      class="mb-1"
    >
      <v-btn value="clouds.yaml" data-testid="os-source-file">clouds.yaml</v-btn>
      <v-btn value="form" data-testid="os-source-form">{{ t('credentials.os.form') }}</v-btn>
    </v-btn-toggle>
    <div class="text-body-small text-medium-emphasis mb-3">
      {{ t('credentials.os.recommendAppCred') }}
    </div>

    <template v-if="osSource === 'clouds.yaml'">
      <v-file-input
        v-model="cloudsFile"
        :label="t('credentials.os.cloudsFile')"
        prepend-icon="mdi-file-upload"
        density="comfortable"
      />
      <v-textarea
        v-model="cloudsYaml"
        :label="t('credentials.os.cloudsYaml')"
        :rules="[required]"
        rows="5"
        name="cloudsYaml"
        class="mb-2"
      >
        <template #append-inner>
          <FieldHelp :text="t('credentials.os.cloudsYamlHint')" />
        </template>
      </v-textarea>
      <ErrorAlert v-if="cloudsError" :error="cloudsError" class="mb-2" />
      <v-select
        v-if="cloudsInfo"
        v-model="cloudName"
        :items="cloudItems"
        :label="t('credentials.os.cloud')"
        class="mb-2"
      >
        <template #append-inner>
          <FieldHelp :text="t('credentials.os.cloudHint')" />
        </template>
      </v-select>
    </template>

    <template v-else>
      <v-text-field
        v-model="authUrl"
        :label="t('credentials.os.authUrl')"
        :rules="[required]"
        placeholder="https://api.pub1.infomaniak.cloud/identity"
      >
        <template #append-inner>
          <FieldHelp :text="t('credentials.os.authUrlHint')" />
        </template>
      </v-text-field>
      <v-text-field
        v-model="region"
        :label="t('credentials.os.region')"
        :rules="[required]"
        placeholder="dc4-a"
        class="mb-2"
      >
        <template #append-inner>
          <FieldHelp :text="t('credentials.os.regionHint')" />
        </template>
      </v-text-field>
      <v-radio-group v-model="authType" inline hide-details class="mb-2">
        <v-radio :label="t('credentials.os.appCred')" value="applicationCredential" />
        <v-radio :label="t('credentials.os.password')" value="password" />
      </v-radio-group>
      <template v-if="authType === 'applicationCredential'">
        <v-text-field
          v-model="appCredId"
          :label="t('credentials.os.appCredId')"
          :rules="[required]"
          autocomplete="off"
        />
        <v-text-field
          v-model="appCredSecret"
          :label="t('credentials.os.appCredSecret')"
          :rules="[required]"
          type="password"
          autocomplete="off"
        />
      </template>
      <template v-else>
        <v-alert type="warning" variant="tonal" density="compact" class="mb-2">{{
          t('credentials.os.passwordWarning')
        }}</v-alert>
        <v-text-field
          v-model="username"
          :label="t('credentials.os.username')"
          :rules="[required]"
          autocomplete="off"
        />
        <v-text-field
          v-model="password"
          :label="t('credentials.os.passwordField')"
          :rules="[required]"
          type="password"
          autocomplete="off"
        />
        <v-text-field
          v-model="projectName"
          :label="t('credentials.os.project')"
          :rules="[required]"
        />
      </template>
    </template>
    <v-textarea v-model="cacert" :label="t('credentials.os.cacert')" rows="2">
      <template #append-inner>
        <FieldHelp :text="t('credentials.os.cacertHint')" />
      </template>
    </v-textarea>
  </div>
</template>
