<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  AwsCredentialInputSchema,
  CredentialNameSchema,
  type CloudsYamlInfo,
  type CreateCredentialRequest,
  type Credential,
  type CredentialProvider,
  type ManifestPreview,
} from '@capi-navigator/shared';
import { ApiError } from '../api/client.js';
import { fieldErrors, zodRule } from '../forms/zod-rules.js';
import { useCredentialsStore } from '../stores/credentials.js';
import ErrorAlert from './ErrorAlert.vue';
import YamlViewer from './YamlViewer.vue';

/** Create or edit OpenStack/AWS credentials (FP4-F-01, FP4-F-07), with YAML preview. */
const props = defineProps<{ provider: CredentialProvider; credential?: Credential | null }>();
const emit = defineEmits<{ close: []; saved: [Credential] }>();
const { t } = useI18n();
const store = useCredentialsStore();

const editing = computed(() => !!props.credential);
const step = ref<'form' | 'preview'>('form');
const name = ref(props.credential?.name ?? '');
const displayName = ref(props.credential?.displayName ?? '');
const namespaces = ref<string[]>(props.credential?.allowedNamespaces ?? ['default']);
const replaceSecret = ref(!props.credential);

// OpenStack
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

// AWS
const accessKeyId = ref('');
const secretAccessKey = ref('');
const awsRegion = ref(props.credential?.summary.region ?? 'eu-central-1');

const valid = ref(false);
const busy = ref(false);
const error = ref<unknown>(null);
const preview = ref<ManifestPreview | null>(null);
const serverFieldErrors = computed(() =>
  error.value instanceof ApiError ? error.value.fieldErrors : undefined,
);
const required = (v: string) => !!v?.trim() || t('credentials.required');
const awsShape = AwsCredentialInputSchema.shape;

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

function openstackInput() {
  const ca = cacert.value.trim() ? { cacert: cacert.value } : {};
  if (osSource.value === 'clouds.yaml') {
    return {
      source: 'clouds.yaml' as const,
      cloudsYaml: cloudsYaml.value,
      ...(cloudName.value ? { cloudName: cloudName.value } : {}),
      ...ca,
    };
  }
  return {
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
}
const awsInput = () => ({
  accessKeyId: accessKeyId.value.trim(),
  secretAccessKey: secretAccessKey.value.trim(),
  region: awsRegion.value.trim(),
});

function createRequest(): CreateCredentialRequest {
  const common = {
    name: name.value,
    allowedNamespaces: namespaces.value,
    ...(displayName.value ? { displayName: displayName.value } : {}),
  };
  return props.provider === 'aws'
    ? { provider: 'aws', ...common, aws: awsInput() }
    : { provider: 'openstack', ...common, openstack: openstackInput() };
}

async function next(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    if (editing.value) {
      const saved = await store.update(props.credential!, {
        displayName: displayName.value,
        allowedNamespaces: namespaces.value,
        ...(replaceSecret.value
          ? props.provider === 'aws'
            ? { aws: awsInput() }
            : { openstack: openstackInput() }
          : {}),
      });
      emit('saved', saved);
    } else {
      preview.value = await store.preview(createRequest());
      step.value = 'preview';
    }
  } catch (err) {
    error.value = err;
  } finally {
    busy.value = false;
  }
}

async function save(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    emit('saved', await store.create(createRequest()));
  } catch (err) {
    error.value = err;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-card>
    <v-card-title class="pt-4 px-6">
      {{
        editing
          ? t('credentials.editTitle', { name: credential?.name })
          : t(`credentials.addTitle.${provider}`)
      }}
    </v-card-title>

    <v-card-text v-if="step === 'form'">
      <v-form v-model="valid" @submit.prevent="next">
        <v-text-field
          v-if="!editing"
          v-model="name"
          :label="t('credentials.name')"
          :rules="[zodRule(CredentialNameSchema)]"
          :hint="t('credentials.nameHint')"
          persistent-hint
          :error-messages="fieldErrors(serverFieldErrors, 'name')"
          class="mb-2"
          name="name"
        />
        <v-text-field
          v-model="displayName"
          :label="t('credentials.displayName')"
          :hint="t('credentials.displayNameHint')"
          persistent-hint
          class="mb-2"
        />
        <v-combobox
          v-model="namespaces"
          :label="t('credentials.allowedNamespaces')"
          :hint="t(`credentials.allowedNamespacesHint.${provider}`)"
          persistent-hint
          multiple
          chips
          closable-chips
          class="mb-3"
          name="allowedNamespaces"
        />

        <v-switch
          v-if="editing"
          v-model="replaceSecret"
          :label="t('credentials.replaceSecret')"
          color="primary"
          density="compact"
          hide-details
          class="mb-2"
        />

        <template v-if="replaceSecret && provider === 'openstack'">
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
          <div class="text-caption text-medium-emphasis mb-3">
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
              :hint="t('credentials.os.cloudsYamlHint')"
              persistent-hint
              :rules="[required]"
              rows="5"
              name="cloudsYaml"
              class="mb-2"
            />
            <ErrorAlert v-if="cloudsError" :error="cloudsError" class="mb-2" />
            <v-select
              v-if="cloudsInfo"
              v-model="cloudName"
              :items="cloudItems"
              :label="t('credentials.os.cloud')"
              :hint="t('credentials.os.cloudHint')"
              persistent-hint
              class="mb-2"
            />
          </template>

          <template v-else>
            <v-text-field
              v-model="authUrl"
              :label="t('credentials.os.authUrl')"
              :rules="[required]"
              :hint="t('credentials.os.authUrlHint')"
              persistent-hint
              placeholder="https://api.pub1.infomaniak.cloud/identity"
              class="mb-2"
            />
            <v-text-field
              v-model="region"
              :label="t('credentials.os.region')"
              :rules="[required]"
              :hint="t('credentials.os.regionHint')"
              persistent-hint
              placeholder="dc4-a"
              class="mb-2"
            />
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
          <v-textarea
            v-model="cacert"
            :label="t('credentials.os.cacert')"
            :hint="t('credentials.os.cacertHint')"
            persistent-hint
            rows="2"
          />
        </template>

        <template v-if="replaceSecret && provider === 'aws'">
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
            :hint="t('credentials.aws.regionHint')"
            persistent-hint
            name="region"
          />
        </template>

        <ErrorAlert v-if="error" :error="error" class="mt-3" />
      </v-form>
    </v-card-text>

    <v-card-text v-else-if="preview">
      <p class="mb-2">{{ t('credentials.previewText') }}</p>
      <YamlViewer :value="preview.yaml" height="300px" :filename="`credential-${name}.yaml`" />
      <ErrorAlert v-if="error" :error="error" class="mt-3" />
    </v-card-text>

    <v-card-actions class="px-6 pb-4">
      <v-btn
        v-if="step === 'preview'"
        variant="text"
        prepend-icon="mdi-arrow-left"
        @click="step = 'form'"
        >{{ t('common.back') }}</v-btn
      >
      <v-spacer />
      <v-btn variant="text" @click="emit('close')">{{ t('common.cancel') }}</v-btn>
      <v-btn
        v-if="step === 'form'"
        color="primary"
        variant="flat"
        :loading="busy"
        :disabled="!valid"
        data-testid="credential-next"
        @click="next"
      >
        {{ editing ? t('credentials.saveAndTest') : t('providers.showPreview') }}
      </v-btn>
      <v-btn
        v-else
        color="primary"
        variant="flat"
        :loading="busy"
        data-testid="credential-save"
        @click="save"
      >
        {{ t('credentials.saveAndTest') }}
      </v-btn>
    </v-card-actions>
  </v-card>
</template>
