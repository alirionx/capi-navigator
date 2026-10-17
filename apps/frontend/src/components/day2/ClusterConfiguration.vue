<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  CONTROL_PLANE_GROUP,
  distributionCatalog,
  upgradeProblem,
  type ClusterSpec,
  type ClusterStatus,
  type LookupOption,
  type SpecChangeInput,
} from '@capi-navigator/shared';
import { useClustersStore } from '../../stores/clusters.js';
import { useCredentialsStore } from '../../stores/credentials.js';
import ChangeDialog from '../ChangeDialog.vue';
import ErrorAlert from '../ErrorAlert.vue';
import CustomizationEditor from '../wizard/CustomizationEditor.vue';
import MachineGroupEditor from '../wizard/MachineGroupEditor.vue';
import { newerImage } from './newer-image.js';

/**
 * Day-2 configuration of a managed cluster (FP-7): every change updates the stored spec and is
 * shown as preview (diff and replaced nodes) before it is applied.
 */
const props = defineProps<{
  connection: string;
  namespace: string;
  name: string;
  status: ClusterStatus;
}>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const clusters = useClustersStore();
const credentials = useCredentialsStore();

const spec = ref<ClusterSpec | null>(null);
const error = ref<unknown>(null);
const sizes = ref<LookupOption[]>([]);
const images = ref<LookupOption[]>([]);
const volumeTypes = ref<LookupOption[]>([]);

async function load(): Promise<void> {
  error.value = null;
  try {
    spec.value = await clusters.getSpec(props.connection, props.namespace, props.name);
    void checkDrift();
    void loadLists();
  } catch (err) {
    error.value = err;
  }
}

// ---- drift (FP7-F-19): regenerate from the spec and compare with the cluster ----
const drift = ref<{ checking: boolean; objects: string[]; fields: string[] } | null>(null);
async function checkDrift(): Promise<void> {
  drift.value = { checking: true, objects: [], fields: [] };
  try {
    const p = await clusters.changePreview(props.connection, props.namespace, props.name, {
      type: 'reapply',
    });
    drift.value = {
      checking: false,
      objects: p.diffs.map((d) => `${d.kind} ${d.name}`),
      fields: p.drift.map(
        (d) => `${d.kind} ${d.name}: ${d.fields.join(', ')} (${d.managers.join(', ')})`,
      ),
    };
  } catch {
    drift.value = null;
  }
}

/** FP7-F-12: newer image of the same OS for a group. */
const suggestion = (g: Group) =>
  newerImage(g.image ?? spec.value?.infrastructure.image, images.value);
watch(() => [props.connection, props.namespace, props.name], load, { immediate: true });

/** Selection lists of the cluster's credentials (flavors / instance types, images, volume types). */
async function loadLists(): Promise<void> {
  const s = spec.value;
  if (!s || sizes.value.length) return;
  try {
    await credentials.load(props.connection);
    const c = credentials.credentials.find(
      (x) => x.provider === s.infrastructure.provider && x.name === s.infrastructure.credentialRef,
    );
    if (!c) return;
    const region = 'region' in s.infrastructure ? s.infrastructure.region : undefined;
    const os = s.infrastructure.provider === 'openstack';
    const [sz, im, vt] = await Promise.all([
      credentials.lookup(c, os ? 'flavors' : 'instanceTypes', region),
      credentials.lookup(c, 'images', region),
      os
        ? credentials.lookup(c, 'volumeTypes', region).catch(() => ({ options: [] }))
        : Promise.resolve({ options: [] }),
    ]);
    sizes.value = sz.options;
    images.value = im.options;
    volumeTypes.value = os ? vt.options : ['gp3', 'gp2'].map((v) => ({ value: v, label: v }));
  } catch {
    // lists are a convenience; the fields still accept typed values
  }
}

type Group =
  ClusterSpec['topology']['controlPlane'] | ClusterSpec['topology']['workerPools'][number];
const groups = computed(() => {
  const s = spec.value;
  if (!s) return [];
  return [
    {
      id: CONTROL_PLANE_GROUP,
      title: t('day2.controlPlane'),
      group: s.topology.controlPlane as Group,
      pool: false,
    },
    ...s.topology.workerPools.map((p) => ({
      id: p.name,
      title: t('wizard.poolTitle', { name: p.name }),
      group: p as Group,
      pool: true,
    })),
  ];
});
const machinesOf = (id: string) =>
  props.status.machines.filter((m) =>
    id === CONTROL_PLANE_GROUP ? m.role === 'control-plane' : m.pool === id,
  );
const rolloutRunning = computed(
  () =>
    (props.status.controlPlane &&
      props.status.machines.filter((m) => m.role === 'control-plane').length !==
        props.status.controlPlane.replicas) ||
    props.status.machineDeployments.some((md) => md.upToDate < md.replicas),
);

// ---- the change dialog ----
type Mode =
  | 'reapply'
  | 'cpScale'
  | 'scale'
  | 'addPool'
  | 'removePool'
  | 'machine'
  | 'customization'
  | 'rebuild'
  | 'rollout'
  | 'upgrade';
const open = ref(false);
const mode = ref<Mode>('scale');
const target = ref('');
interface MachineForm {
  machineSize: string;
  image?: string;
  rootVolumeSizeGB?: number;
  rootVolumeType?: string;
}
interface Day2Form {
  replicas: number;
  ack: boolean;
  name: string;
  group: MachineForm;
  confirm: string;
  c: NonNullable<Group['customization']>;
  maxSurge: number;
  maxUnavailable: number;
  version: string;
}
const emptyForm = (): Day2Form => ({
  replicas: 0,
  ack: false,
  name: '',
  group: { machineSize: '' },
  confirm: '',
  c: { files: [], preCommands: [], postCommands: [] },
  maxSurge: 1,
  maxUnavailable: 0,
  version: '',
});
const form = ref<Day2Form>(emptyForm());

function start(m: Mode, groupId = '', g?: Group): void {
  mode.value = m;
  target.value = groupId;
  const s = spec.value!;
  switch (m) {
    case 'reapply':
      form.value = emptyForm();
      break;
    case 'cpScale':
      form.value = { ...emptyForm(), replicas: s.topology.controlPlane.replicas, ack: false };
      break;
    case 'scale':
      form.value = { ...emptyForm(), replicas: (g as { replicas: number }).replicas };
      break;
    case 'addPool':
      form.value = {
        ...emptyForm(),
        name: '',
        replicas: 1,
        group: { machineSize: s.topology.workerPools[0]?.machineSize ?? '' },
      };
      break;
    case 'removePool':
      form.value = { ...emptyForm(), confirm: '' };
      break;
    case 'machine':
      form.value = {
        ...emptyForm(),
        group: {
          machineSize: g!.machineSize,
          image: g!.image,
          rootVolumeSizeGB: g!.rootVolumeSizeGB,
          rootVolumeType: g!.rootVolumeType,
        },
      };
      break;
    case 'customization':
      form.value = {
        ...emptyForm(),
        c: structuredClone(g!.customization ?? { files: [], preCommands: [], postCommands: [] }),
      };
      break;
    case 'rebuild':
      form.value = { ...emptyForm() };
      break;
    case 'rollout': {
      const r =
        (g as { rollout?: { maxSurge: number; maxUnavailable: number } }).rollout ?? s.rollout;
      form.value = { ...emptyForm(), maxSurge: r.maxSurge, maxUnavailable: r.maxUnavailable };
      break;
    }
    case 'upgrade':
      form.value = { ...emptyForm(), version: upgradeTargets.value[0]?.value ?? '' };
      break;
  }
  if (m === 'machine' || m === 'addPool') void loadLists();
  open.value = true;
}

const upgradeTargets = computed(() => {
  const s = spec.value;
  if (!s) return [];
  const cat = distributionCatalog(s.kubernetes.flavor);
  return (cat?.versions ?? [])
    .filter((v) => !upgradeProblem(s.kubernetes.version, v.version))
    .map((v) => ({
      value: v.version,
      title: `${v.version}${v.untested ? ` (${t('wizard.untested')})` : ''}`,
    }));
});

const change = computed<SpecChangeInput | null>(() => {
  const f = form.value;
  switch (mode.value) {
    case 'reapply':
      return { type: 'reapply' };
    case 'cpScale':
      return { type: 'scaleControlPlane', replicas: f.replicas as 1 | 3 | 5 };
    case 'scale':
      return { type: 'scale', pool: target.value, replicas: Number(f.replicas) };
    case 'addPool':
      return {
        type: 'addPool',
        pool: {
          name: f.name.trim(),
          replicas: Number(f.replicas),
          machineSize: f.group.machineSize,
          ...(f.group.image ? { image: f.group.image } : {}),
          ...(f.group.rootVolumeSizeGB
            ? { rootVolumeSizeGB: Number(f.group.rootVolumeSizeGB) }
            : {}),
          ...(f.group.rootVolumeType ? { rootVolumeType: f.group.rootVolumeType } : {}),
        },
      };
    case 'removePool':
      return { type: 'removePool', pool: target.value };
    case 'machine':
      return {
        type: 'machine',
        group: target.value,
        machineSize: f.group.machineSize,
        ...(f.group.image ? { image: f.group.image } : {}),
        ...(f.group.rootVolumeSizeGB ? { rootVolumeSizeGB: Number(f.group.rootVolumeSizeGB) } : {}),
        ...(f.group.rootVolumeType ? { rootVolumeType: f.group.rootVolumeType } : {}),
      };
    case 'customization':
      return { type: 'customization', group: target.value, customization: f.c };
    case 'rebuild':
      return { type: 'rebuild', group: target.value };
    case 'rollout':
      return {
        type: 'rolloutSettings',
        pool: target.value,
        settings: { maxSurge: Number(f.maxSurge), maxUnavailable: Number(f.maxUnavailable) },
      };
    case 'upgrade':
      return f.version ? { type: 'upgrade', version: f.version } : null;
  }
  return null;
});

const valid = computed(() => {
  const f = form.value;
  const s = spec.value;
  if (!s || !change.value) return false;
  switch (mode.value) {
    case 'cpScale':
      return (
        f.replicas !== s.topology.controlPlane.replicas &&
        (f.replicas > s.topology.controlPlane.replicas || f.ack)
      );
    case 'scale':
      return Number.isInteger(Number(f.replicas)) && Number(f.replicas) >= 0;
    case 'addPool':
      return /^[a-z0-9]([-a-z0-9]{0,10}[a-z0-9])?$/.test(f.name.trim()) && !!f.group.machineSize;
    case 'removePool':
      return f.confirm === target.value;
    case 'rollout':
      return Number(f.maxSurge) + Number(f.maxUnavailable) > 0;
    default:
      return true;
  }
});

const title = computed(() => t(`day2.title.${mode.value}`, { group: target.value }));
const preview = () =>
  clusters.changePreview(props.connection, props.namespace, props.name, change.value!);
const apply = async (takeOver: boolean) => {
  await clusters.applyChange(
    props.connection,
    props.namespace,
    props.name,
    change.value!,
    takeOver,
  );
  await load();
  emit('changed');
};

/** Opens the size & image dialog with the suggested newer image. */
function useNewerImage(groupId: string, g: Group, image: string): void {
  start('machine', groupId, g);
  form.value.group.image = image;
}

const rolloutOf = (g: Group) =>
  ('rollout' in g && g.rollout ? g.rollout : spec.value!.rollout) as Record<string, unknown>;
const custSummary = (g: Group) => {
  const c = g.customization;
  if (!c) return t('day2.none');
  return t('day2.custSummary', {
    files: c.files.length,
    commands: c.preCommands.length + c.postCommands.length,
  });
};
const shortImage = (id?: string) =>
  id ? (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id) : t('day2.clusterImage');
const provider = computed(() =>
  spec.value?.infrastructure.provider === 'aws' ? 'aws' : 'openstack',
);
</script>

<template>
  <div data-testid="cluster-configuration">
    <ErrorAlert v-if="error" :error="error" class="mb-3" />
    <v-progress-linear v-if="!spec && !error" indeterminate />
    <template v-if="spec">
      <v-alert v-if="rolloutRunning" type="info" variant="tonal" density="compact" class="mb-3">{{
        t('day2.rolloutRunning')
      }}</v-alert>

      <!-- Kubernetes version -->
      <v-card border class="mb-4" data-testid="day2-kubernetes">
        <v-card-item
          :title="t('day2.kubernetes')"
          :subtitle="`${spec.kubernetes.flavor} · ${spec.kubernetes.version}`"
        >
          <template #append>
            <v-btn
              variant="tonal"
              prepend-icon="mdi-arrow-up-bold-circle-outline"
              :disabled="!upgradeTargets.length || !!spec.kubernetes.workerVersion"
              data-testid="day2-upgrade"
              @click="start('upgrade')"
              >{{ t('day2.upgrade') }}</v-btn
            >
          </template>
        </v-card-item>
        <v-card-text v-if="spec.kubernetes.workerVersion">
          <v-alert type="info" variant="tonal" density="compact">{{
            t('day2.upgradeRunning', {
              version: spec.kubernetes.version,
              worker: spec.kubernetes.workerVersion,
            })
          }}</v-alert>
        </v-card-text>
      </v-card>

      <!-- Drift (FP7-F-19) -->
      <v-card border class="mb-4" data-testid="day2-drift">
        <v-card-item :title="t('day2.drift')">
          <template #append>
            <v-chip
              v-if="drift"
              size="small"
              variant="tonal"
              :color="
                drift.checking
                  ? 'grey'
                  : drift.objects.length || drift.fields.length
                    ? 'warning'
                    : 'success'
              "
              data-testid="day2-drift-state"
              >{{
                drift.checking
                  ? t('day2.driftChecking')
                  : drift.objects.length || drift.fields.length
                    ? t('day2.driftFound', { n: drift.objects.length })
                    : t('day2.noDrift')
              }}</v-chip
            >
            <v-btn
              size="small"
              variant="tonal"
              class="ml-2"
              prepend-icon="mdi-backup-restore"
              data-testid="day2-reapply"
              @click="start('reapply')"
              >{{ t('day2.reapply') }}</v-btn
            >
          </template>
        </v-card-item>
        <v-card-text
          v-if="drift && !drift.checking && (drift.objects.length || drift.fields.length)"
        >
          <div class="text-body-2 mb-1">{{ t('day2.driftExplain') }}</div>
          <div v-for="o in drift.fields" :key="o" class="text-caption font-monospace">{{ o }}</div>
          <div v-for="o in drift.objects" :key="o" class="text-caption">{{ o }}</div>
        </v-card-text>
      </v-card>

      <!-- Groups -->
      <v-row>
        <v-col v-for="g in groups" :key="g.id" cols="12" md="6">
          <v-card border class="fill-height" :data-testid="`day2-group-${g.id}`">
            <v-card-item
              :title="g.title"
              :subtitle="t('day2.nodes', { n: g.group.replicas, running: machinesOf(g.id).length })"
            />
            <v-card-text>
              <v-table density="compact" class="mb-3">
                <tbody>
                  <tr>
                    <td class="text-medium-emphasis" style="width: 10rem">{{ t('infra.size') }}</td>
                    <td>{{ g.group.machineSize }}</td>
                  </tr>
                  <tr>
                    <td class="text-medium-emphasis">{{ t('infra.image') }}</td>
                    <td class="font-monospace text-caption" :title="g.group.image">
                      {{ shortImage(g.group.image) }}
                    </td>
                  </tr>
                  <tr>
                    <td class="text-medium-emphasis">{{ t('infra.rootDisk') }}</td>
                    <td>
                      {{
                        g.group.rootVolumeSizeGB
                          ? `${g.group.rootVolumeSizeGB} GB${g.group.rootVolumeType ? ` · ${g.group.rootVolumeType}` : ''}`
                          : t('infra.localDisk')
                      }}
                    </td>
                  </tr>
                  <tr>
                    <td class="text-medium-emphasis">{{ t('day2.customization') }}</td>
                    <td>{{ custSummary(g.group) }}</td>
                  </tr>
                  <tr v-if="g.pool">
                    <td class="text-medium-emphasis">{{ t('day2.rolloutSettings') }}</td>
                    <td>{{ t('day2.surge', rolloutOf(g.group)) }}</td>
                  </tr>
                </tbody>
              </v-table>
              <v-alert
                v-if="suggestion(g.group)"
                type="info"
                variant="tonal"
                density="compact"
                class="mb-3"
                :data-testid="`day2-newer-image-${g.id}`"
              >
                {{ t('day2.newerImage', { name: suggestion(g.group)!.label }) }}
                <v-btn
                  size="small"
                  variant="text"
                  class="ml-1"
                  @click="useNewerImage(g.id, g.group, suggestion(g.group)!.value)"
                  >{{ t('day2.useImage') }}</v-btn
                >
              </v-alert>
              <div class="d-flex flex-wrap ga-2">
                <v-btn
                  v-if="!g.pool && spec.topology.mode === 'standard'"
                  size="small"
                  variant="tonal"
                  prepend-icon="mdi-arrow-expand-vertical"
                  data-testid="day2-cp-scale"
                  @click="start('cpScale')"
                  >{{ t('changes.scale') }}</v-btn
                >
                <v-btn
                  v-if="g.pool"
                  size="small"
                  variant="tonal"
                  prepend-icon="mdi-arrow-expand-vertical"
                  :data-testid="`day2-scale-${g.id}`"
                  @click="start('scale', g.id, g.group)"
                  >{{ t('changes.scale') }}</v-btn
                >
                <v-btn
                  size="small"
                  variant="tonal"
                  prepend-icon="mdi-server"
                  :data-testid="`day2-machine-${g.id}`"
                  @click="start('machine', g.id, g.group)"
                  >{{ t('day2.machine') }}</v-btn
                >
                <v-btn
                  size="small"
                  variant="tonal"
                  prepend-icon="mdi-script-text-outline"
                  :data-testid="`day2-customization-${g.id}`"
                  @click="start('customization', g.id, g.group)"
                  >{{ t('day2.customization') }}</v-btn
                >
                <v-btn
                  size="small"
                  variant="tonal"
                  prepend-icon="mdi-autorenew"
                  :data-testid="`day2-rebuild-${g.id}`"
                  @click="start('rebuild', g.id, g.group)"
                  >{{ t('day2.rebuild') }}</v-btn
                >
                <v-btn
                  v-if="g.pool"
                  size="small"
                  variant="tonal"
                  prepend-icon="mdi-tune-variant"
                  @click="start('rollout', g.id, g.group)"
                  >{{ t('day2.rolloutSettings') }}</v-btn
                >
                <v-btn
                  v-if="g.pool && spec.topology.workerPools.length > 1"
                  size="small"
                  variant="tonal"
                  color="error"
                  prepend-icon="mdi-delete-outline"
                  :data-testid="`day2-remove-${g.id}`"
                  @click="start('removePool', g.id, g.group)"
                  >{{ t('day2.removePool') }}</v-btn
                >
              </div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
      <v-btn
        v-if="spec.topology.mode === 'standard'"
        class="mt-4"
        variant="tonal"
        prepend-icon="mdi-plus"
        data-testid="day2-add-pool"
        @click="start('addPool')"
        >{{ t('wizard.addPool') }}</v-btn
      >

      <ChangeDialog v-model="open" :title="title" :valid="valid" :preview="preview" :apply="apply">
        <v-alert v-if="mode === 'reapply'" type="info" variant="tonal">{{
          t('day2.reapplyExplain')
        }}</v-alert>
        <template v-else-if="mode === 'cpScale'">
          <v-btn-toggle v-model="form.replicas" mandatory variant="outlined" density="comfortable">
            <v-btn :value="1">1</v-btn><v-btn :value="3">3</v-btn><v-btn :value="5">5</v-btn>
          </v-btn-toggle>
          <div class="text-caption text-medium-emphasis mt-2">{{ t('wizard.cpHint') }}</div>
          <v-alert
            v-if="form.replicas < spec.topology.controlPlane.replicas"
            type="warning"
            variant="tonal"
            class="mt-3"
          >
            {{ t('day2.quorumWarning') }}
            <v-checkbox
              v-model="form.ack"
              :label="t('day2.quorumAck')"
              data-testid="day2-quorum-ack"
            />
          </v-alert>
        </template>
        <v-text-field
          v-else-if="mode === 'scale'"
          v-model.number="form.replicas"
          type="number"
          min="0"
          :label="t('changes.replicas')"
          :hint="
            t('changes.replicasHint', {
              current: groups.find((x) => x.id === target)?.group.replicas ?? 0,
            })
          "
          persistent-hint
        />
        <template v-else-if="mode === 'addPool'">
          <div class="d-flex ga-3 mb-3">
            <v-text-field
              v-model="form.name"
              :label="t('wizard.poolName')"
              :hint="t('wizard.poolNameHint')"
              persistent-hint
              data-testid="day2-pool-name"
            />
            <v-text-field
              v-model.number="form.replicas"
              type="number"
              min="0"
              :label="t('wizard.replicas')"
              style="max-width: 9rem"
            />
          </div>
          <MachineGroupEditor
            v-model="form.group"
            :provider="provider"
            :sizes="sizes"
            :images="images"
            :volume-types="volumeTypes"
            role="worker"
          />
        </template>
        <template v-else-if="mode === 'removePool'">
          <v-alert type="warning" variant="tonal" class="mb-3">{{
            t('day2.removeWarning', { pool: target })
          }}</v-alert>
          <v-text-field
            v-model="form.confirm"
            :label="t('deletion.confirmLabel', { name: target })"
            autocomplete="off"
            data-testid="day2-remove-confirm"
          />
        </template>
        <template v-else-if="mode === 'machine'">
          <v-alert type="info" variant="tonal" density="compact" class="mb-3">{{
            t('day2.rebuildNote')
          }}</v-alert>
          <MachineGroupEditor
            v-model="form.group"
            :provider="provider"
            :sizes="sizes"
            :images="images"
            :volume-types="volumeTypes"
            :role="target === 'control-plane' ? 'control-plane' : 'worker'"
          />
        </template>
        <template v-else-if="mode === 'customization'">
          <v-alert type="warning" variant="tonal" density="compact" class="mb-3">{{
            t('wizard.customWarning')
          }}</v-alert>
          <CustomizationEditor v-model="form.c" />
        </template>
        <v-alert v-else-if="mode === 'rebuild'" type="info" variant="tonal">{{
          t('day2.rebuildExplain', { group: target })
        }}</v-alert>
        <div v-else-if="mode === 'rollout'" class="d-flex ga-3">
          <v-text-field
            v-model.number="form.maxSurge"
            type="number"
            min="0"
            max="10"
            label="maxSurge"
            :hint="t('day2.maxSurgeHint')"
            persistent-hint
          />
          <v-text-field
            v-model.number="form.maxUnavailable"
            type="number"
            min="0"
            max="10"
            label="maxUnavailable"
            :hint="t('day2.maxUnavailableHint')"
            persistent-hint
          />
        </div>
        <template v-else-if="mode === 'upgrade'">
          <v-select
            v-model="form.version"
            :items="upgradeTargets"
            :label="t('day2.targetVersion')"
            :hint="t('day2.upgradeHint', { current: spec.kubernetes.version })"
            persistent-hint
            data-testid="day2-version"
          />
          <v-alert type="info" variant="tonal" density="compact" class="mt-3">{{
            t('day2.upgradeOrder')
          }}</v-alert>
        </template>
      </ChangeDialog>
    </template>
  </div>
</template>
