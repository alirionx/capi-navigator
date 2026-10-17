<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ShellServerMessageSchema } from '@capi-navigator/shared';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

/**
 * Root shell on a node (FP-17, ADR-0008): xterm.js in the browser, WebSocket to the backend,
 * which runs nsenter in a privileged pod on the node. Closing the dialog ends the session.
 */
const props = defineProps<{ title: string; path: string }>();
const open = defineModel<boolean>({ required: true });
const { t } = useI18n();

const container = ref<HTMLElement | null>(null);
const term = shallowRef<Terminal | null>(null);
const state = ref<'starting' | 'connected' | 'closed' | 'error'>('starting');
const status = ref('');
const hint = ref('');
let ws: WebSocket | null = null;
let fit: FitAddon | null = null;
let observer: ResizeObserver | null = null;

function send(msg: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function resize(): void {
  if (!term.value || !fit) return;
  fit.fit();
  send({ type: 'resize', cols: term.value.cols, rows: term.value.rows });
}

async function start(): Promise<void> {
  state.value = 'starting';
  status.value = t('shell.starting');
  hint.value = '';
  await nextTick();
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/xterm/css/xterm.css'),
  ]);
  if (!container.value || !open.value) return;
  const t2 = new Terminal({
    cursorBlink: true,
    fontFamily: "'JetBrains Mono', 'Cascadia Mono', Menlo, Consolas, monospace",
    fontSize: 13,
    scrollback: 5000,
    theme: { background: '#0e0f12', foreground: '#e6e8eb', cursor: '#3ddbc0' },
  });
  fit = new FitAddon();
  t2.loadAddon(fit);
  t2.open(container.value);
  term.value = t2;
  fit.fit();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}${props.path}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data !== 'string') {
      t2.write(new Uint8Array(e.data));
      return;
    }
    const parsed = ShellServerMessageSchema.safeParse(JSON.parse(e.data));
    if (!parsed.success) return;
    const m = parsed.data;
    if (m.type === 'error') {
      state.value = 'error';
      status.value = m.message;
      hint.value = m.hint ?? '';
    } else if (m.state === 'connected') {
      state.value = 'connected';
      status.value = '';
      resize();
      t2.focus();
    } else {
      if (m.state === 'closed') state.value = 'closed';
      status.value = m.message ?? '';
    }
  };
  ws.onclose = (e) => {
    if (state.value === 'error') return;
    if (e.code === 1006 || e.code === 1008 || (state.value === 'starting' && e.code !== 1000)) {
      state.value = 'error';
      status.value = t('shell.refused');
      return;
    }
    state.value = 'closed';
    status.value = status.value || t('shell.ended');
  };
  t2.onData((data) => send({ type: 'input', data }));
  observer = new ResizeObserver(() => resize());
  observer.observe(container.value);
}

function stop(): void {
  observer?.disconnect();
  observer = null;
  ws?.close(1000, 'closed by user');
  ws = null;
  term.value?.dispose();
  term.value = null;
  fit = null;
}

watch(open, (o) => (o ? void start() : stop()), { immediate: true });
onBeforeUnmount(stop);

function restart(): void {
  stop();
  void start();
}
</script>

<template>
  <v-dialog v-model="open" max-width="1200" persistent>
    <v-card data-testid="node-shell">
      <v-card-item>
        <template #prepend>
          <v-icon icon="mdi-console" color="primary" />
        </template>
        <v-card-title>{{ title }}</v-card-title>
        <template #append>
          <v-chip size="small" color="warning" variant="tonal" class="mr-2">{{
            t('shell.root')
          }}</v-chip>
          <v-chip
            size="small"
            variant="tonal"
            :color="state === 'connected' ? 'success' : state === 'error' ? 'error' : 'info'"
            data-testid="shell-state"
            >{{ t(`shell.state.${state}`) }}</v-chip
          >
        </template>
      </v-card-item>
      <v-card-text>
        <v-alert
          v-if="status && state !== 'connected'"
          :type="state === 'error' ? 'error' : 'info'"
          variant="tonal"
          density="compact"
          class="mb-2"
        >
          {{ status }}
          <div v-if="hint" class="text-caption mt-1">{{ hint }}</div>
        </v-alert>
        <div ref="container" class="terminal" />
        <div class="text-caption text-medium-emphasis mt-2">{{ t('shell.note') }}</div>
      </v-card-text>
      <v-card-actions>
        <v-btn
          v-if="state === 'closed' || state === 'error'"
          prepend-icon="mdi-restart"
          @click="restart"
          >{{ t('shell.reconnect') }}</v-btn
        >
        <v-spacer />
        <v-btn color="primary" variant="flat" data-testid="shell-close" @click="open = false">{{
          t('common.close')
        }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.terminal {
  height: 60vh;
  min-height: 320px;
  padding: 8px;
  border-radius: 8px;
  background: #0e0f12;
  overflow: hidden;
}
</style>
