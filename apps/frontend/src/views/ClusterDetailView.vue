<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Condition, LookupOption, MachineStatus } from '@capi-navigator/shared';
import { CHECK_NEUTRON_PAGING, isReservedLabel } from '@capi-navigator/shared';
import { useRouter } from 'vue-router';
import ChangeDialog from '../components/ChangeDialog.vue';
import ImageLabel from '../components/ImageLabel.vue';
import BastionEditor, { type BastionDraft } from '../components/BastionEditor.vue';
import { sshJumpCommand, sshUserFor } from '../composables/ssh.js';
import { useCredentialsStore } from '../stores/credentials.js';
import DeleteClusterDialog from '../components/DeleteClusterDialog.vue';
import KubeconfigDialog from '../components/KubeconfigDialog.vue';
import NodeShellDialog from '../components/shell/NodeShellDialog.vue';
import ResourceTree from '../components/ResourceTree.vue';
import { formatAge, formatCreated, useNow } from '../composables/age.js';
import { useAuthStore } from '../stores/auth.js';
import { useClustersStore } from '../stores/clusters.js';
import { useConnectionsStore } from '../stores/connections.js';

/** Live status of a cluster (US-07, FP6-F-02): overview, machines and events. */
const props = defineProps<{ namespace: string; name: string }>();
const { t } = useI18n();
const connections = useConnectionsStore();
const store = useClustersStore();
const tab = ref('overview');
const auth = useAuthStore();
const router = useRouter();
const showKubeconfig = ref(false);
const now = useNow();
const deleteOpen = ref(false);

// ---- spec changes (FP6-F-05, FP6-F-07): managed clusters, operators only ----
const canChange = computed(
  () => auth.can('operator') && !!s.value?.summary.managed && !s.value.summary.deletion,
);
/** Deleting again is possible when nothing runs or the cleanup timed out. */
const canDelete = computed(
  () =>
    auth.can('operator') &&
    !!s.value?.summary.managed &&
    (!s.value.summary.deletion || s.value.summary.deletion.phase === 'cleanup-timeout'),
);
const conn = () => connections.activeName!;

// ---- bastion (FP5-F-20) ----
const credentials = useCredentialsStore();
const bastionOpen = ref(false);
const bastionDraft = ref<BastionDraft>({ enabled: false, machineSize: '', allowedCidrs: [] });
const bastionSizes = ref<LookupOption[]>([]);
const bastionPagingWarning = ref<string | undefined>();
async function openBastion(): Promise<void> {
  const b = s.value?.bastion;
  bastionDraft.value = {
    enabled: b?.enabled ?? false,
    machineSize: b?.machineSize ?? '',
    allowedCidrs: b?.allowedCidrs ?? [],
  };
  bastionOpen.value = true;
  const info = s.value?.infraSummary;
  if (!info || !connections.activeName) return;
  try {
    await credentials.load(connections.activeName);
    const c = credentials.credentials.find(
      (x) => x.provider === info.provider && x.name === info.credentialRef,
    );
    if (c) {
      const check = c.lastTest?.checks.find((x) => x.id === CHECK_NEUTRON_PAGING);
      bastionPagingWarning.value = check && !check.ok ? check.message : undefined;
      const kind = info.provider === 'openstack' ? 'flavors' : 'instanceTypes';
      bastionSizes.value = (await credentials.lookup(c, kind, info.region)).options;
    }
  } catch {
    bastionSizes.value = [];
  }
}
const bastionRequest = () => ({
  bastion: {
    enabled: bastionDraft.value.enabled,
    ...(bastionDraft.value.machineSize ? { machineSize: bastionDraft.value.machineSize } : {}),
    ...(s.value?.infraSummary?.provider === 'aws' && bastionDraft.value.enabled
      ? { allowedCidrs: bastionDraft.value.allowedCidrs.map((c) => c.trim()) }
      : {}),
  },
});
const bastionValid = computed(() => {
  const d = bastionDraft.value;
  if (!d.enabled) return true;
  if (!s.value?.infraSummary?.sshKeyName) return false;
  return s.value.infraSummary.provider === 'openstack'
    ? !!d.machineSize
    : d.allowedCidrs.length > 0;
});
const bastionRunning = computed(() => !!s.value?.bastion?.enabled);
/** `ssh -J` command for a machine, if bastion and node address are known. */
function sshCommand(m: MachineStatus): string | undefined {
  const b = s.value?.bastion;
  if (!b?.enabled || !b.publicIP || !m.internalIP) return undefined;
  const nodeUser = sshUserFor(m.imageName) ?? '<user>';
  // The OpenStack bastion uses the cluster image; CAPA's default bastion AMI is Ubuntu.
  const bastionUser = s.value?.infraSummary?.provider === 'aws' ? 'ubuntu' : nodeUser;
  return sshJumpCommand({ bastionIP: b.publicIP, bastionUser, nodeIP: m.internalIP, nodeUser });
}
const copiedCmd = ref<string | null>(null);

// ---- node shell (FP-17): operators, machines with a node ----
const shellNode = ref<string | null>(null);
const shellOpen = ref(false);
function openShell(node: string): void {
  shellNode.value = node;
  shellOpen.value = true;
}
async function copyCmd(cmd: string): Promise<void> {
  await navigator.clipboard.writeText(cmd);
  copiedCmd.value = cmd;
  setTimeout(() => (copiedCmd.value = null), 1200);
}

const scaling = ref<{ pool: string; current: number } | null>(null);
const scaleOpen = ref(false);
const replicas = ref(0);
function openScale(pool: string, current: number): void {
  scaling.value = { pool, current };
  replicas.value = current;
  scaleOpen.value = true;
}
const replicasValid = computed(
  () => Number.isInteger(replicas.value) && replicas.value >= 0 && replicas.value <= 100,
);
const scaleRequest = () => ({ pool: scaling.value!.pool, replicas: Number(replicas.value) });

const labelsOpen = ref(false);
const labelItems = ref<string[]>([]);
function openLabels(): void {
  labelItems.value = Object.entries(s.value?.summary.labels ?? {})
    .filter(([k]) => !isReservedLabel(k))
    .map(([k, v]) => `${k}=${v}`);
  labelsOpen.value = true;
}
const parsedLabels = computed(() => {
  const out: Record<string, string> = {};
  for (const item of labelItems.value) {
    const i = item.indexOf('=');
    if (i <= 0) return null;
    const key = item.slice(0, i).trim();
    if (isReservedLabel(key)) return null;
    out[key] = item.slice(i + 1).trim();
  }
  return out;
});

watch(
  () => [connections.activeName, props.namespace, props.name] as const,
  ([conn, ns, name]) => {
    store.status = null;
    if (conn) store.watch(conn, ns, name);
  },
  { immediate: true },
);
onBeforeUnmount(() => store.unwatch());

const s = computed(() => store.status);
const failing = (conds: Condition[]) => conds.filter((c) => c.status !== 'True' && c.message);
const color = (ok: boolean) => (ok ? 'success' : 'info');
const machineColor = (m: MachineStatus) =>
  m.phase === 'Running'
    ? 'success'
    : m.phase === 'Failed'
      ? 'error'
      : m.phase === 'Deleting'
        ? 'warning'
        : 'info';
const warnings = computed(() => s.value?.events.filter((e) => e.type === 'Warning').length ?? 0);
const when = (iso?: string) =>
  iso
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(
        new Date(iso),
      )
    : '–';

const machineHeaders = computed(() => [
  { title: t('clusters.name'), key: 'name' },
  { title: t('clusters.role'), key: 'role' },
  { title: t('clusters.phase'), key: 'phase' },
  { title: t('clusters.size'), key: 'size' },
  { title: t('clusters.image'), key: 'image' },
  { title: t('clusters.rootDisk'), key: 'rootVolumeGB' },
  { title: t('clusters.node'), key: 'nodeName' },
  { title: 'providerID', key: 'providerID' },
  { title: t('clusters.age'), key: 'createdAt' },
  { title: '', key: 'shell', sortable: false },
  { title: '', key: 'data-table-expand' },
]);
</script>

<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <v-btn
        icon="mdi-arrow-left"
        variant="text"
        :to="{ name: 'clusters' }"
        :aria-label="t('common.back')"
      />
      <div>
        <h1 class="page-title">{{ name }}</h1>
        <p class="text-body-2 text-medium-emphasis mt-1">
          {{ namespace }}
          <template v-if="s">
            · {{ s.summary.provider ?? '–' }} · {{ s.summary.flavor ?? '–' }}
            {{ s.summary.version ? '· ' + s.summary.version : '' }}
            <span v-if="s.summary.createdAt" :title="formatCreated(s.summary.createdAt)">
              · {{ t('clusters.age') }} {{ formatAge(s.summary.createdAt, now) }}</span
            >
          </template>
        </p>
      </div>
      <v-chip
        v-if="s && !s.summary.managed"
        size="small"
        variant="tonal"
        class="ml-2"
        :title="t('clusters.externalHint')"
        >{{ t('clusters.external') }}</v-chip
      >
      <v-spacer />
      <v-btn
        v-if="canDelete"
        variant="tonal"
        color="error"
        prepend-icon="mdi-delete-outline"
        data-testid="delete-cluster"
        @click="deleteOpen = true"
        >{{ t('deletion.action') }}</v-btn
      >
      <v-btn
        v-if="canChange"
        variant="tonal"
        prepend-icon="mdi-tag-multiple-outline"
        data-testid="edit-labels"
        @click="openLabels"
        >{{ t('changes.labels') }}</v-btn
      >
      <v-btn
        v-if="s?.kubeconfigAvailable && auth.can('operator')"
        variant="tonal"
        prepend-icon="mdi-file-key-outline"
        data-testid="show-kubeconfig"
        @click="showKubeconfig = true"
        >{{ t('kubeconfig.show') }}</v-btn
      >
      <v-chip
        :color="store.live ? 'success' : 'grey'"
        variant="tonal"
        prepend-icon="mdi-access-point"
      >
        {{ store.live ? t('providers.live') : t('providers.connecting') }}
      </v-chip>
    </div>

    <v-alert v-if="store.statusError" type="error" variant="tonal" class="mb-4">{{
      store.statusError
    }}</v-alert>
    <v-progress-linear v-if="!s && !store.statusError" indeterminate />

    <v-alert
      v-if="s?.summary.deletion"
      :type="s.summary.deletion.phase === 'cleanup-timeout' ? 'warning' : 'info'"
      variant="tonal"
      class="mb-4"
      data-testid="deletion-status"
    >
      <div class="font-weight-medium">
        {{ t(`deletion.phase.${s.summary.deletion.phase}`) }}
      </div>
      <div v-if="s.summary.deletion.message" class="text-body-2">
        {{ s.summary.deletion.message }}
      </div>
      <div v-if="s.summary.deletion.phase === 'cleanup-timeout'" class="text-body-2 mt-1">
        {{ t('deletion.timeoutHint') }}
      </div>
    </v-alert>

    <template v-if="s">
      <v-tabs v-model="tab" class="mb-4">
        <v-tab value="overview">{{ t('clusters.overview') }}</v-tab>
        <v-tab value="tree" data-testid="tab-tree">{{ t('clusters.tree') }}</v-tab>
        <v-tab value="machines">
          {{ t('clusters.machines') }}
          <v-chip size="x-small" class="ml-2" variant="tonal">{{ s.machines.length }}</v-chip>
        </v-tab>
        <v-tab value="events" data-testid="tab-events">
          {{ t('clusters.events') }}
          <v-chip v-if="warnings" size="x-small" class="ml-2" color="warning" variant="tonal">{{
            warnings
          }}</v-chip>
        </v-tab>
      </v-tabs>

      <v-window v-model="tab">
        <!-- Overview -->
        <v-window-item value="overview">
          <v-row>
            <v-col cols="12" md="3">
              <v-card border class="fill-height" data-testid="cluster-phase">
                <v-card-item
                  :title="t('clusters.phase')"
                  :subtitle="
                    s.summary.provider + (s.summary.version ? ' · ' + s.summary.version : '')
                  "
                />
                <v-card-text>
                  <v-chip :color="s.summary.ready ? 'success' : 'info'" variant="tonal">{{
                    s.summary.ready ? t('clusters.ready') : s.summary.phase
                  }}</v-chip>
                  <div
                    v-if="s.summary.createdAt"
                    class="text-caption mt-2"
                    data-testid="cluster-created"
                  >
                    {{
                      t('clusters.created', {
                        date: formatCreated(s.summary.createdAt),
                        age: formatAge(s.summary.createdAt, now),
                      })
                    }}
                  </div>
                  <div v-if="s.kubeconfigAvailable" class="text-caption">
                    {{ t('clusters.kubeconfigReady') }}
                  </div>
                </v-card-text>
              </v-card>
            </v-col>
            <v-col v-if="s.infrastructure" cols="12" md="3">
              <v-card border class="fill-height">
                <v-card-item :title="s.infrastructure.kind" :subtitle="s.infrastructure.name" />
                <v-card-text>
                  <v-chip :color="color(s.infrastructure.ready)" variant="tonal">{{
                    s.infrastructure.ready ? t('clusters.provisioned') : t('clusters.provisioning')
                  }}</v-chip>
                </v-card-text>
              </v-card>
            </v-col>
            <v-col v-if="s.controlPlane" cols="12" md="3">
              <v-card border class="fill-height">
                <v-card-item :title="s.controlPlane.kind" :subtitle="s.controlPlane.version" />
                <v-card-text>
                  <v-chip
                    :color="color(s.controlPlane.ready === s.controlPlane.replicas)"
                    variant="tonal"
                    >{{ s.controlPlane.ready }}/{{ s.controlPlane.replicas }}
                    {{ t('clusters.available') }}</v-chip
                  >
                </v-card-text>
              </v-card>
            </v-col>
            <v-col v-for="md in s.machineDeployments" :key="md.name" cols="12" md="3">
              <v-card border class="fill-height">
                <v-card-item
                  :title="t('wizard.poolTitle', { name: md.pool ?? md.name })"
                  subtitle="MachineDeployment"
                />
                <v-card-text class="d-flex align-center">
                  <v-chip :color="color(md.ready === md.replicas)" variant="tonal"
                    >{{ md.ready }}/{{ md.replicas }} {{ t('clusters.ready') }}</v-chip
                  >
                  <v-spacer />
                  <v-btn
                    v-if="canChange && md.pool"
                    size="small"
                    variant="tonal"
                    prepend-icon="mdi-arrow-expand-vertical"
                    :data-testid="`scale-${md.pool}`"
                    @click="openScale(md.pool, md.replicas)"
                    >{{ t('changes.scale') }}</v-btn
                  >
                </v-card-text>
              </v-card>
            </v-col>
          </v-row>

          <!-- Infrastructure (FP6-F-02): what the cluster is built from -->
          <v-card v-if="s.infraSummary" border class="mt-4" data-testid="infra-summary">
            <v-card-item :title="t('infra.title')" :subtitle="t('infra.subtitle')" />
            <v-card-text>
              <div class="d-flex flex-wrap ga-6 mb-4">
                <div v-for="f in s.infraSummary.facts" :key="f.label">
                  <div class="text-caption text-medium-emphasis">{{ f.label }}</div>
                  <div class="text-body-2 font-monospace">{{ f.value }}</div>
                </div>
              </div>
              <v-table density="comfortable">
                <thead>
                  <tr>
                    <th>{{ t('infra.group') }}</th>
                    <th>{{ t('infra.nodes') }}</th>
                    <th>{{ t('infra.size') }}</th>
                    <th>{{ t('infra.image') }}</th>
                    <th>{{ t('infra.rootDisk') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="g in s.infraSummary.groups" :key="g.name">
                    <td class="font-weight-medium">{{ g.name }}</td>
                    <td>{{ g.replicas }}</td>
                    <td>{{ g.size ?? '–' }}</td>
                    <td class="py-2" style="max-width: 26rem">
                      <ImageLabel
                        v-if="g.image"
                        :id="g.image.id"
                        :name="g.image.name"
                        :not-found="g.image.notFound"
                      />
                      <span v-else>–</span>
                    </td>
                    <td>
                      <template v-if="g.rootVolumeGB"
                        >{{ g.rootVolumeGB }} GB{{
                          g.rootVolumeType ? ` · ${g.rootVolumeType}` : ''
                        }}</template
                      >
                      <span v-else class="text-medium-emphasis">{{ t('infra.localDisk') }}</span>
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </v-card-text>
          </v-card>

          <!-- Bastion host (FP5-F-20) -->
          <v-card
            v-if="s.summary.managed && (s.bastion || canChange)"
            border
            class="mt-4"
            data-testid="bastion-card"
          >
            <v-card-item :title="t('bastion.title')">
              <template #append>
                <v-btn
                  v-if="canChange"
                  size="small"
                  variant="tonal"
                  prepend-icon="mdi-shield-key-outline"
                  data-testid="manage-bastion"
                  @click="openBastion"
                  >{{ t('bastion.manage') }}</v-btn
                >
              </template>
            </v-card-item>
            <v-card-text>
              <div v-if="!s.bastion" class="text-medium-emphasis">{{ t('bastion.off') }}</div>
              <template v-else>
                <div class="d-flex flex-wrap ga-6">
                  <div>
                    <div class="text-caption text-medium-emphasis">{{ t('bastion.state') }}</div>
                    <v-chip
                      size="small"
                      variant="tonal"
                      :color="
                        s.bastion.enabled ? (s.bastion.publicIP ? 'success' : 'info') : undefined
                      "
                      >{{
                        s.bastion.enabled
                          ? (s.bastion.state ?? t('bastion.waiting'))
                          : t('bastion.off')
                      }}</v-chip
                    >
                  </div>
                  <div v-if="s.bastion.publicIP">
                    <div class="text-caption text-medium-emphasis">{{ t('bastion.publicIP') }}</div>
                    <div class="font-monospace" data-testid="bastion-ip">
                      {{ s.bastion.publicIP }}
                    </div>
                  </div>
                  <div v-if="s.bastion.privateIP">
                    <div class="text-caption text-medium-emphasis">
                      {{ t('bastion.privateIP') }}
                    </div>
                    <div class="font-monospace">{{ s.bastion.privateIP }}</div>
                  </div>
                  <div v-if="s.bastion.allowedCidrs?.length">
                    <div class="text-caption text-medium-emphasis">{{ t('bastion.cidrs') }}</div>
                    <div class="font-monospace">{{ s.bastion.allowedCidrs.join(', ') }}</div>
                  </div>
                </div>
                <v-alert
                  v-if="s.bastion.enabled && s.bastion.openToAll"
                  type="warning"
                  variant="tonal"
                  density="compact"
                  class="mt-3"
                  >{{ t('bastion.openStackOpen') }}</v-alert
                >
              </template>
            </v-card-text>
          </v-card>

          <v-alert
            v-for="c in failing(s.conditions)"
            :key="c.type"
            type="info"
            variant="tonal"
            density="compact"
            class="mt-4"
          >
            <strong>{{ c.type }}</strong> ({{ c.reason }}): {{ c.message }}
          </v-alert>
        </v-window-item>

        <!-- Resource tree (FP6-F-03) -->
        <v-window-item value="tree">
          <ResourceTree :status="s" />
        </v-window-item>

        <!-- Machines -->
        <v-window-item value="machines">
          <v-card border class="table-card">
            <v-data-table
              :headers="machineHeaders"
              :items="s.machines"
              item-value="name"
              show-expand
              density="comfortable"
              :items-per-page="-1"
              hide-default-footer
              :no-data-text="t('clusters.noMachines')"
              data-testid="machines"
            >
              <template #[`item.role`]="{ item }">
                {{ item.role === 'control-plane' ? 'control plane' : (item.pool ?? 'worker') }}
              </template>
              <template #[`item.phase`]="{ item }">
                <v-chip size="small" variant="tonal" :color="machineColor(item)">{{
                  item.phase
                }}</v-chip>
              </template>
              <template #[`item.size`]="{ item }">{{ item.size ?? '–' }}</template>
              <template #[`item.image`]="{ item }">
                <span
                  v-if="item.image"
                  :title="item.image"
                  :class="item.imageName ? '' : 'font-monospace text-caption'"
                  >{{
                    item.imageName ??
                    (item.image.length > 20
                      ? item.image.slice(0, 8) + '…' + item.image.slice(-4)
                      : item.image)
                  }}</span
                >
                <span v-else>–</span>
              </template>
              <template #[`item.rootVolumeGB`]="{ item }">{{
                item.rootVolumeGB ? `${item.rootVolumeGB} GB` : '–'
              }}</template>
              <template #[`item.nodeName`]="{ item }">{{ item.nodeName ?? '–' }}</template>
              <template #[`item.shell`]="{ item }">
                <v-btn
                  v-if="item.nodeName && auth.can('operator')"
                  size="small"
                  variant="tonal"
                  prepend-icon="mdi-console"
                  :data-testid="`shell-${item.name}`"
                  @click="openShell(item.nodeName)"
                  >{{ t('shell.open') }}</v-btn
                >
              </template>
              <template #[`item.createdAt`]="{ item }">
                <span :title="formatCreated(item.createdAt)">{{
                  formatAge(item.createdAt, now)
                }}</span>
              </template>
              <template #[`item.providerID`]="{ item }">
                <span class="text-caption font-monospace">{{ item.providerID ?? '–' }}</span>
              </template>
              <template #expanded-row="{ columns, item }">
                <tr>
                  <td :colspan="columns.length" class="py-3">
                    <div v-if="s.bastion?.enabled" class="mb-3">
                      <div class="text-subtitle-2 mb-1">{{ t('bastion.sshCommand') }}</div>
                      <div v-if="sshCommand(item)" class="d-flex align-center ga-1">
                        <code class="ssh-cmd" data-testid="ssh-command">{{
                          sshCommand(item)
                        }}</code>
                        <v-btn
                          :icon="copiedCmd === sshCommand(item) ? 'mdi-check' : 'mdi-content-copy'"
                          size="x-small"
                          variant="text"
                          :aria-label="t('yaml.copy')"
                          @click="copyCmd(sshCommand(item)!)"
                        />
                      </div>
                      <div v-else class="text-caption text-medium-emphasis">
                        {{ s.bastion.publicIP ? t('bastion.noIP') : t('bastion.waiting') }}
                      </div>
                      <div class="text-caption text-medium-emphasis mt-1">
                        {{ t('bastion.sshHint') }}
                      </div>
                    </div>
                    <div v-if="item.image" class="mb-3" style="max-width: 32rem">
                      <div class="text-subtitle-2 mb-1">{{ t('infra.image') }}</div>
                      <ImageLabel :id="item.image" :name="item.imageName" dense />
                    </div>
                    <div class="text-subtitle-2 mb-2">{{ t('clusters.conditions') }}</div>
                    <v-table density="compact">
                      <tbody>
                        <tr v-for="c in item.conditions" :key="c.type">
                          <td style="width: 14rem">{{ c.type }}</td>
                          <td style="width: 5rem">
                            <v-icon
                              :color="c.status === 'True' ? 'success' : 'warning'"
                              :icon="c.status === 'True' ? 'mdi-check-circle' : 'mdi-alert-circle'"
                              size="small"
                            />
                          </td>
                          <td class="text-caption">
                            {{ c.reason }}{{ c.message ? ': ' + c.message : '' }}
                          </td>
                        </tr>
                      </tbody>
                    </v-table>
                  </td>
                </tr>
              </template>
            </v-data-table>
          </v-card>
        </v-window-item>

        <!-- Events -->
        <v-window-item value="events">
          <v-card border class="table-card">
            <v-table density="comfortable" data-testid="events">
              <thead>
                <tr>
                  <th style="width: 2rem"></th>
                  <th>{{ t('clusters.eventObject') }}</th>
                  <th>{{ t('clusters.eventReason') }}</th>
                  <th>{{ t('clusters.eventMessage') }}</th>
                  <th>{{ t('clusters.eventLastSeen') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(e, i) in s.events"
                  :key="`${e.object.kind}/${e.object.name}/${e.reason}/${i}`"
                >
                  <td>
                    <v-icon
                      :icon="e.type === 'Warning' ? 'mdi-alert' : 'mdi-information-outline'"
                      :color="e.type === 'Warning' ? 'warning' : undefined"
                      size="small"
                    />
                  </td>
                  <td class="text-no-wrap">
                    {{ e.object.kind }}/<span class="font-weight-medium">{{ e.object.name }}</span>
                  </td>
                  <td>{{ e.reason }}</td>
                  <td class="text-caption">
                    {{ e.message }}<span v-if="e.count > 1"> (×{{ e.count }})</span>
                  </td>
                  <td class="text-no-wrap text-caption">{{ when(e.lastSeen) }}</td>
                </tr>
                <tr v-if="s.events.length === 0">
                  <td colspan="5" class="text-medium-emphasis">{{ t('clusters.noEvents') }}</td>
                </tr>
              </tbody>
            </v-table>
          </v-card>
        </v-window-item>
      </v-window>
    </template>
    <ChangeDialog
      v-if="s?.infraSummary"
      v-model="bastionOpen"
      :title="t('bastion.changeTitle')"
      :valid="bastionValid"
      :preview="() => store.bastionPreview(conn(), namespace, name, bastionRequest())"
      :apply="
        (takeOver) => store.setBastion(conn(), namespace, name, { ...bastionRequest(), takeOver })
      "
    >
      <BastionEditor
        v-model="bastionDraft"
        :provider="s.infraSummary.provider === 'aws' ? 'aws' : 'openstack'"
        :sizes="bastionSizes"
        :has-key-pair="!!s.infraSummary.sshKeyName"
        :paging-warning="bastionPagingWarning"
        :size-locked="bastionRunning && bastionDraft.enabled"
      />
    </ChangeDialog>
    <ChangeDialog
      v-if="scaling"
      v-model="scaleOpen"
      :title="t('changes.scaleTitle', { pool: scaling.pool })"
      :valid="replicasValid && replicas !== scaling.current"
      :preview="() => store.scalePreview(conn(), namespace, name, scaleRequest())"
      :apply="(takeOver) => store.scale(conn(), namespace, name, { ...scaleRequest(), takeOver })"
    >
      <v-text-field
        v-model.number="replicas"
        type="number"
        min="0"
        max="100"
        :label="t('changes.replicas')"
        :hint="t('changes.replicasHint', { current: scaling.current })"
        persistent-hint
        data-testid="scale-replicas"
      />
    </ChangeDialog>
    <ChangeDialog
      v-model="labelsOpen"
      :title="t('changes.labelsTitle')"
      :valid="parsedLabels !== null"
      :preview="() => store.labelsPreview(conn(), namespace, name, { labels: parsedLabels! })"
      :apply="
        (takeOver) => store.setLabels(conn(), namespace, name, { labels: parsedLabels!, takeOver })
      "
    >
      <v-combobox
        v-model="labelItems"
        :label="t('changes.labelsField')"
        :hint="t('changes.labelsHint')"
        persistent-hint
        multiple
        chips
        closable-chips
        :error-messages="parsedLabels === null ? [t('changes.labelsInvalid')] : []"
        data-testid="labels-field"
      />
    </ChangeDialog>
    <DeleteClusterDialog
      v-if="connections.activeName"
      v-model="deleteOpen"
      :connection="connections.activeName"
      :namespace="namespace"
      :name="name"
      @deleted="router.push({ name: 'clusters' })"
    />
    <NodeShellDialog
      v-if="shellNode && connections.activeName"
      v-model="shellOpen"
      :title="t('shell.title', { node: shellNode })"
      :path="`/api/connections/${encodeURIComponent(connections.activeName)}/clusters/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/nodes/${encodeURIComponent(shellNode)}/shell`"
    />
    <KubeconfigDialog
      v-if="connections.activeName"
      v-model="showKubeconfig"
      :connection="connections.activeName"
      :namespace="namespace"
      :name="name"
    />
  </v-container>
</template>

<style scoped>
.ssh-cmd {
  font-size: 0.8rem;
  padding: 2px 6px;
  border-radius: 6px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  word-break: break-all;
}
</style>
