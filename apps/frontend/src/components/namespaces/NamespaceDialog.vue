<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  ManagedNamespaceSpecSchema,
  NAMESPACE_PROFILE_QUOTAS,
  NAMESPACE_PROFILES,
  NAMESPACE_QUOTA_RESOURCES,
  NAMESPACE_ROLES,
  nextRevision,
  personKey,
  personLabel,
  singleClusterSelector,
  type AddonPreview,
  type ManagedNamespaceSpec,
  type ManagedNamespaceSpecInput,
  type NamespaceAccount,
  type NamespacePerson,
  type NamespaceProfile,
  type NamespaceQuota,
} from '@capi-navigator/shared';
import ChangeDialog from '../ChangeDialog.vue';
import ErrorAlert from '../ErrorAlert.vue';
import FieldHelp from '../FieldHelp.vue';
import ClusterSelectorField from '../addons/ClusterSelectorField.vue';
import { selectorLabels, selectorRows, type SelectorRow } from '../addons/selector.js';
import { useNamespacesStore, type ClusterKey } from '../../stores/namespaces.js';

/** Create or change a managed namespace (FP36-F-01, F-02): form, preview, apply (hard rule 6). */
const props = defineProps<{
  cluster: ClusterKey;
  /** Existing namespace; its name and selector are fixed. */
  initial?: ManagedNamespaceSpec;
  /** Name of a left-over namespace to take over again (FP36-F-04). */
  takeOverName?: string;
}>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ applied: [] }>();
const { t } = useI18n();
const store = useNamespacesStore();

const name = ref('');
const profile = ref<NamespaceProfile>('small');
const quota = ref<NamespaceQuota>({ ...NAMESPACE_PROFILE_QUOTAS.small });
const allowFrom = ref<string[]>([]);
const accounts = ref<NamespaceAccount[]>([]);
const selector = ref<SelectorRow[]>([]);
const fixed = computed(() => !!props.initial);

watch(
  open,
  (o) => {
    if (!o) return;
    const i = props.initial;
    name.value = i?.name ?? props.takeOverName ?? '';
    profile.value = i?.profile ?? 'small';
    quota.value = { ...(i?.quota ?? NAMESPACE_PROFILE_QUOTAS.small) };
    allowFrom.value = [...(i?.allowFrom ?? [])];
    accounts.value = i
      ? i.accounts.map((a) => ({ ...a, people: [...a.people] }))
      : [{ name: 'team', role: 'edit', people: [] }];
    void loadPeople();
    selector.value = selectorRows(i?.clusterSelector ?? singleClusterSelector(props.cluster.name));
  },
  { immediate: true },
);

/** FP37-F-02: the reduced list, plus stored people that are no longer in it. */
const people = ref<NamespacePerson[]>([]);
const peopleError = ref<unknown>(null);
async function loadPeople(): Promise<void> {
  peopleError.value = null;
  try {
    people.value = await store.people(props.cluster);
  } catch (err) {
    people.value = [];
    peopleError.value = err;
  }
}
const ICONS = { user: 'mdi-account', person: 'mdi-account-key', group: 'mdi-account-group' };
const peopleItems = computed(() => {
  const known = new Map(people.value.map((p) => [personKey(p), p]));
  for (const p of props.initial?.accounts.flatMap((a) => a.people) ?? []) {
    if (!known.has(personKey(p))) known.set(personKey(p), p);
  }
  return [...known.values()].map((p) => ({
    value: p,
    title: personLabel(p),
    props: { prependIcon: ICONS[p.kind], subtitle: t(`namespaces.people.${p.kind}`) },
  }));
});

function selectProfile(p: NamespaceProfile): void {
  profile.value = p;
  quota.value = { ...NAMESPACE_PROFILE_QUOTAS[p] };
}

const QUOTA_FIELDS = Object.keys(NAMESPACE_QUOTA_RESOURCES) as (keyof NamespaceQuota)[];

const form = (): ManagedNamespaceSpecInput => ({
  name: name.value.trim(),
  namespace: props.cluster.namespace,
  clusterSelector: selectorLabels(selector.value),
  profile: profile.value,
  quota: quota.value,
  allowFrom: allowFrom.value,
  accounts: accounts.value,
});
const spec = (): ManagedNamespaceSpecInput => {
  const next = form();
  return { ...next, revision: nextRevision(next, props.initial) };
};
const parsed = computed(() => ManagedNamespaceSpecSchema.safeParse(spec()));
const errors = (path: string) =>
  parsed.value.success
    ? []
    : parsed.value.error.issues
        .filter((i) => i.path.join('.') === path)
        .map((i) => i.message)
        .slice(0, 1);

const lastPreview = ref<AddonPreview | null>(null);
async function preview(): Promise<AddonPreview> {
  lastPreview.value = await store.preview(props.cluster, { spec: spec() });
  return lastPreview.value;
}
const apply = (takeOver: boolean) => store.apply(props.cluster, { spec: spec(), takeOver });
const maps = (field: string) => t('addons.mapsTo', { field });
</script>

<template>
  <ChangeDialog
    v-model="open"
    :title="fixed ? t('namespaces.editTitle', { name: initial!.name }) : t('namespaces.newTitle')"
    :valid="parsed.success"
    :preview="preview"
    :apply="apply"
    :form-width="820"
    @applied="emit('applied')"
  >
    <v-text-field
      v-model="name"
      :label="t('namespaces.name')"
      :disabled="fixed || !!takeOverName"
      :error-messages="name ? errors('name') : []"
      class="mt-2"
      data-testid="namespace-name"
    >
      <template #append-inner>
        <FieldHelp :text="`${t('namespaces.nameHint')} ${maps('Namespace.metadata.name')}`" />
      </template>
    </v-text-field>

    <div class="text-title-small mt-2 mb-2">
      {{ t('namespaces.profile') }}
      <FieldHelp :text="`${t('namespaces.profileHint')} ${maps('ResourceQuota, LimitRange')}`" />
    </div>
    <v-btn-toggle
      :model-value="profile"
      mandatory
      color="primary"
      variant="outlined"
      density="comfortable"
      class="mb-3"
      @update:model-value="selectProfile"
    >
      <v-btn
        v-for="p in NAMESPACE_PROFILES"
        :key="p"
        :value="p"
        :data-testid="`namespace-profile-${p}`"
        >{{ t(`namespaces.profiles.${p}`) }}</v-btn
      >
    </v-btn-toggle>
    <v-row density="compact">
      <v-col v-for="f in QUOTA_FIELDS" :key="f" cols="6" sm="3">
        <v-text-field
          v-model.number="quota[f]"
          type="number"
          density="compact"
          :label="t(`namespaces.quota.${f}`)"
          :error-messages="errors(`quota.${f}`)"
          :data-testid="`namespace-quota-${f}`"
        >
          <template #append-inner>
            <FieldHelp
              :text="`${t('namespaces.quotaHint', { value: NAMESPACE_PROFILE_QUOTAS[profile][f] })} ${maps(`ResourceQuota.spec.hard[${NAMESPACE_QUOTA_RESOURCES[f]}]`)}`"
            />
          </template>
        </v-text-field>
      </v-col>
    </v-row>

    <v-combobox
      v-model="allowFrom"
      :label="t('namespaces.allowFrom')"
      :error-messages="
        parsed.success
          ? []
          : parsed.error.issues.some((i) => i.path[0] === 'allowFrom')
            ? [t('namespaces.allowFromInvalid')]
            : []
      "
      multiple
      chips
      closable-chips
      class="mt-4"
      data-testid="namespace-allow-from"
    >
      <template #append-inner>
        <FieldHelp
          :text="`${t('namespaces.allowFromHint')} ${maps('NetworkPolicy (Calico) spec.ingress')}`"
        />
      </template>
    </v-combobox>

    <div class="text-title-small mt-2 mb-2">
      {{ t('namespaces.accounts') }}
      <FieldHelp
        :text="`${t('namespaces.accountsHint')} ${maps('ServiceAccount, RoleBinding.roleRef')}`"
      />
    </div>
    <div v-for="(a, i) in accounts" :key="i" class="mb-2">
      <div class="d-flex ga-2 align-start">
        <v-text-field
          v-model="a.name"
          :label="t('namespaces.account')"
          density="compact"
          :error-messages="a.name ? errors(`accounts.${i}.name`) : []"
          :data-testid="`namespace-account-${i}`"
        />
        <v-select
          v-model="a.role"
          :items="NAMESPACE_ROLES.map((r) => ({ value: r, title: t(`namespaces.roles.${r}`) }))"
          :label="t('namespaces.role')"
          density="compact"
          :data-testid="`namespace-role-${i}`"
        />
        <v-btn
          icon="mdi-close"
          size="small"
          variant="text"
          class="mt-1"
          :aria-label="t('common.delete')"
          @click="accounts.splice(i, 1)"
        />
      </div>
      <v-autocomplete
        v-model="a.people"
        :items="peopleItems"
        :value-comparator="(x, y) => !!x && !!y && personKey(x) === personKey(y)"
        :label="t('namespaces.assigned')"
        :error-messages="errors(`accounts.${i}.people`)"
        density="compact"
        multiple
        chips
        closable-chips
        clear-on-select
        :data-testid="`namespace-people-${i}`"
      >
        <template #append-inner>
          <FieldHelp :text="`${t('namespaces.assignedHint')} ${maps('metadata.annotations')}`" />
        </template>
      </v-autocomplete>
    </div>
    <ErrorAlert v-if="peopleError" :error="peopleError" class="mb-2" />
    <v-btn
      size="small"
      variant="text"
      prepend-icon="mdi-plus"
      data-testid="namespace-add-account"
      @click="accounts.push({ name: '', role: 'view', people: [] })"
      >{{ t('namespaces.addAccount') }}</v-btn
    >

    <v-expansion-panels v-if="!fixed" class="mt-3" variant="accordion">
      <v-expansion-panel :title="t('namespaces.clusters')">
        <v-expansion-panel-text>
          <p class="text-body-small text-medium-emphasis">{{ t('namespaces.clustersHint') }}</p>
          <ClusterSelectorField
            v-model="selector"
            :connection="cluster.connection"
            :namespace="cluster.namespace"
            :active="open"
          />
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <template #preview>
      <v-alert
        v-if="lastPreview?.matchingClusters.length"
        type="success"
        variant="tonal"
        density="compact"
        class="mb-2"
        data-testid="namespace-matching"
        >{{
          t('addons.installsOn', { clusters: lastPreview.matchingClusters.join(', ') })
        }}</v-alert
      >
    </template>
  </ChangeDialog>
</template>
