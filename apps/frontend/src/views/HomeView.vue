<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ClusterShapes from '../components/ClusterShapes.vue';
import ProviderGraph from '../components/ProviderGraph.vue';
import { useClustersStore } from '../stores/clusters.js';
import { useConnectionsStore } from '../stores/connections.js';
import { useHealthStore } from '../stores/health.js';
import { useOperatorStore } from '../stores/operator.js';

const { t } = useI18n();
const store = useHealthStore();
const connections = useConnectionsStore();
const operator = useOperatorStore();
const clusters = useClustersStore();

onMounted(() => {
  void store.load();
});

// FP6-F-08: providers and the clusters using them, live for the active management cluster.
watch(
  () => connections.activeName,
  (name) => {
    if (name) {
      operator.connect(name);
      clusters.watchList(name);
    } else {
      operator.disconnect();
      clusters.unwatchList();
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  operator.disconnect();
  clusters.unwatchList();
});
</script>

<template>
  <v-container>
    <h1 class="page-title">{{ t('home.title') }}</h1>
    <p class="text-body-2 text-medium-emphasis mt-1 mb-6">{{ t('home.subtitle') }}</p>

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

    <v-card v-if="connections.active" border class="mt-6" data-testid="overview">
      <v-card-item
        :title="t('overview.title', { name: connections.activeName })"
        :subtitle="t('overview.subtitle')"
      />
      <v-card-text>
        <v-progress-linear v-if="!operator.state" indeterminate />
        <ProviderGraph v-else :providers="operator.state.providers" :clusters="clusters.clusters" />
      </v-card-text>
    </v-card>

    <!-- UX-02: the shape of every workload cluster. -->
    <v-card v-if="connections.active" border class="mt-6">
      <v-card-item :title="t('shapes.title')" :subtitle="t('shapes.subtitle')" />
      <v-card-text>
        <ClusterShapes :clusters="clusters.clusters" />
      </v-card-text>
    </v-card>
  </v-container>
</template>
