<script setup lang="ts">
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useHealthStore } from '../stores/health.js';

const { t } = useI18n();
const store = useHealthStore();

onMounted(() => {
  void store.load();
});
</script>

<template>
  <v-container>
    <h1 class="page-title">{{ t('home.title') }}</h1>
    <p class="text-medium-emphasis mb-6">{{ t('home.subtitle') }}</p>

    <v-card max-width="520" border>
      <v-list>
        <v-list-item data-testid="backend-status">
          <template #prepend>
            <v-icon
              :icon="
                store.health
                  ? 'mdi-check-circle'
                  : store.error
                    ? 'mdi-alert-circle'
                    : 'mdi-timer-sand'
              "
              :color="store.health ? 'success' : store.error ? 'error' : undefined"
            />
          </template>
          <v-list-item-title>
            {{ t('home.backend') }}:
            <span v-if="store.health">{{ t('home.ok') }}</span>
            <span v-else-if="store.error">{{ t('home.error') }}</span>
            <span v-else>{{ t('home.checking') }}</span>
          </v-list-item-title>
          <v-list-item-subtitle v-if="store.health">
            {{ t('home.version', { version: store.health.version }) }}
          </v-list-item-subtitle>
          <v-list-item-subtitle v-else-if="store.error">{{ store.error }}</v-list-item-subtitle>
        </v-list-item>

        <v-list-item v-if="store.health" data-testid="home-cluster-status">
          <template #prepend>
            <v-icon
              :icon="store.health.homeCluster.reachable ? 'mdi-kubernetes' : 'mdi-lan-disconnect'"
              :color="store.health.homeCluster.reachable ? 'success' : 'warning'"
            />
          </template>
          <v-list-item-title>
            {{ t('home.homeCluster') }}:
            {{ store.health.homeCluster.reachable ? t('home.ok') : t('home.unreachable') }}
          </v-list-item-title>
          <v-list-item-subtitle>
            {{ store.health.homeCluster.version ?? store.health.homeCluster.message }}
          </v-list-item-subtitle>
        </v-list-item>
      </v-list>
      <v-card-actions>
        <v-btn
          :loading="store.loading"
          variant="tonal"
          prepend-icon="mdi-refresh"
          @click="store.load()"
        >
          {{ t('home.refresh') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-container>
</template>
