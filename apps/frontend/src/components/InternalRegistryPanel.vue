<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  DEFAULT_MIRRORED_REGISTRIES,
  InternalRegistrySchema,
  type InternalRegistry,
} from '@capi-navigator/shared';
import { ApiError } from '../api/client.js';
import { fieldErrors, zodRule } from '../forms/zod-rules.js';
import { useAuthStore } from '../stores/auth.js';
import { useConnectionsStore } from '../stores/connections.js';
import ErrorAlert from './ErrorAlert.vue';

/**
 * Internal OCI registry of the active management cluster (FP29-F-10): air-gapped workload
 * clusters pull their images through it and download the distribution's binaries from it. Admins
 * change it; new clusters copy it, existing ones keep their copy.
 */
const { t } = useI18n();
const auth = useAuthStore();
const connections = useConnectionsStore();
const isAdmin = computed(() => auth.can('connections.manage'));

const registry = computed(() => connections.active?.internalRegistry);

const shape = InternalRegistrySchema.shape;
const editOpen = ref(false);
const valid = ref(false);
const form = ref({
  host: '',
  artifactsPath: '',
  caCert: '',
  mirrors: [] as { upstream: string; path: string }[],
});
const saving = ref(false);
const saveError = ref<unknown>(null);
const serverFieldErrors = computed(() =>
  saveError.value instanceof ApiError ? saveError.value.fieldErrors : undefined,
);

function edit(): void {
  const r = registry.value;
  form.value = {
    host: r?.host ?? '',
    artifactsPath: r?.artifactsPath ?? '',
    caCert: r?.caCert ?? '',
    mirrors: r
      ? r.mirrors.map((m) => ({ upstream: m.upstream, path: m.path ?? '' }))
      : DEFAULT_MIRRORED_REGISTRIES.map((upstream) => ({ upstream, path: '' })),
  };
  saveError.value = null;
  editOpen.value = true;
}

async function save(settings: InternalRegistry | null): Promise<void> {
  saving.value = true;
  saveError.value = null;
  try {
    await connections.update(connections.activeName!, { internalRegistry: settings });
    editOpen.value = false;
  } catch (err) {
    saveError.value = err;
  } finally {
    saving.value = false;
  }
}

function submit(): Promise<void> {
  const f = form.value;
  return save({
    host: f.host.trim(),
    artifactsPath: f.artifactsPath.trim(),
    ...(f.caCert.trim() ? { caCert: f.caCert.trim() } : {}),
    mirrors: f.mirrors
      .filter((m) => m.upstream.trim())
      .map((m) => ({
        upstream: m.upstream.trim(),
        ...(m.path.trim() ? { path: m.path.trim() } : {}),
      })),
  });
}
const optionalPath = (v: string) => !v.trim() || zodRule(shape.artifactsPath)(v.trim());
</script>

<template>
  <v-card border class="mt-6" data-testid="internal-registry-panel">
    <v-card-item>
      <v-card-title class="text-subtitle-1">{{ t('registry.title') }}</v-card-title>
      <v-card-subtitle class="text-wrap">{{ t('registry.subtitle') }}</v-card-subtitle>
      <template #append>
        <v-btn
          v-if="isAdmin"
          size="small"
          variant="text"
          prepend-icon="mdi-pencil"
          data-testid="edit-internal-registry"
          @click="edit"
          >{{ t('registry.change') }}</v-btn
        >
      </template>
    </v-card-item>
    <v-card-text>
      <div v-if="!registry" class="text-body-2 text-medium-emphasis">
        {{ t('registry.none') }}
      </div>
      <v-table v-else density="compact" class="registry-table">
        <tbody>
          <tr>
            <td>{{ t('registry.host') }}</td>
            <td class="mono">{{ registry.host }}</td>
          </tr>
          <tr>
            <td>{{ t('registry.caCert') }}</td>
            <td>{{ registry.caCert ? t('registry.caSet') : '–' }}</td>
          </tr>
          <tr v-for="m in registry.mirrors" :key="m.upstream">
            <td>{{ t('registry.mirrorOf', { upstream: m.upstream }) }}</td>
            <td class="mono">{{ registry.host }}/{{ m.path ? `${m.path}/` : '' }}…</td>
          </tr>
          <tr>
            <td>{{ t('registry.artifactsPath') }}</td>
            <td class="mono">{{ registry.host }}/{{ registry.artifactsPath }}/…</td>
          </tr>
        </tbody>
      </v-table>
    </v-card-text>
  </v-card>

  <v-dialog v-model="editOpen" max-width="720">
    <v-card :title="t('registry.editTitle')">
      <v-card-text>
        <p class="text-body-2 mb-4">{{ t('registry.editInfo') }}</p>
        <v-form v-model="valid" @submit.prevent="submit">
          <v-text-field
            v-model="form.host"
            :label="t('registry.host')"
            :hint="t('registry.hostHint')"
            persistent-hint
            placeholder="registry.example.com"
            :rules="[zodRule(shape.host)]"
            :error-messages="fieldErrors(serverFieldErrors, 'internalRegistry.host')"
            class="mb-3"
            data-testid="registry-host"
          />
          <div class="text-subtitle-2 mb-1">{{ t('registry.mirrors') }}</div>
          <div class="text-caption text-medium-emphasis mb-2">{{ t('registry.mirrorsHint') }}</div>
          <v-row v-for="(m, i) in form.mirrors" :key="i" dense>
            <v-col cols="5"
              ><v-text-field
                v-model="m.upstream"
                :label="t('registry.upstream')"
                density="compact"
                :data-testid="`registry-upstream-${i}`"
            /></v-col>
            <v-col cols="6"
              ><v-text-field
                v-model="m.path"
                :label="t('registry.path')"
                density="compact"
                :rules="[optionalPath]"
                :data-testid="`registry-path-${i}`"
            /></v-col>
            <v-col cols="1" class="d-flex align-center"
              ><v-btn
                icon="mdi-delete-outline"
                size="small"
                variant="text"
                :aria-label="t('common.delete')"
                @click="form.mirrors.splice(i, 1)"
            /></v-col>
          </v-row>
          <v-btn
            size="small"
            variant="text"
            prepend-icon="mdi-plus"
            class="mb-4"
            @click="form.mirrors.push({ upstream: '', path: '' })"
            >{{ t('registry.addMirror') }}</v-btn
          >
          <v-text-field
            v-model="form.artifactsPath"
            :label="t('registry.artifactsPath')"
            :hint="t('registry.artifactsPathHint')"
            persistent-hint
            placeholder="library"
            :rules="[zodRule(shape.artifactsPath)]"
            class="mb-3"
            data-testid="registry-artifacts-path"
          />
          <v-textarea
            v-model="form.caCert"
            :label="t('registry.caCert')"
            :hint="t('registry.caCertHint')"
            persistent-hint
            rows="3"
            placeholder="-----BEGIN CERTIFICATE-----"
            :rules="[zodRule(shape.caCert)]"
            class="mono-input"
            data-testid="registry-ca"
          />
        </v-form>
        <ErrorAlert v-if="saveError" :error="saveError" class="mt-3" />
      </v-card-text>
      <v-card-actions>
        <v-btn
          v-if="registry"
          color="error"
          variant="text"
          :loading="saving"
          data-testid="remove-internal-registry"
          @click="save(null)"
          >{{ t('registry.remove') }}</v-btn
        >
        <v-spacer />
        <v-btn variant="text" @click="editOpen = false">{{ t('common.cancel') }}</v-btn>
        <v-btn
          color="primary"
          :loading="saving"
          :disabled="!valid || !form.mirrors.some((m) => m.upstream.trim())"
          data-testid="save-internal-registry"
          @click="submit"
          >{{ t('common.save') }}</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.mono,
.mono-input :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
}
.registry-table td:first-child {
  width: 220px;
  color: rgb(var(--v-theme-on-surface), 0.7);
}
.mono {
  word-break: break-all;
}
</style>
