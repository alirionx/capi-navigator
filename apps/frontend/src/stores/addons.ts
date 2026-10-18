import { defineStore } from 'pinia';
import { ref } from 'vue';
import { z } from 'zod';
import {
  AddonDeletePreviewSchema,
  AddonOverviewSchema,
  AddonPreviewSchema,
  type AddonOverview,
  type AddonSpecInput,
} from '@capi-navigator/shared';
import { api, apiVoid } from '../api/client.js';
import { liveStream } from '../api/live.js';

const base = (connection: string) => `/api/connections/${encodeURIComponent(connection)}/addons`;
const item = (connection: string, namespace: string, name: string) =>
  `${base(connection)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;

/** Helm add-ons of the active management cluster, live (FP-8). */
export const useAddonsStore = defineStore('addons', () => {
  const overview = ref<AddonOverview | null>(null);
  const error = ref<string | null>(null);
  const live = ref(false);
  const loading = ref(false);
  let stop: (() => void) | null = null;
  let watchers = 0;
  let watchedConnection: string | null = null;

  /** Reference-counted, so the add-on page and a cluster's tab can share one stream. */
  function watch(connection: string): () => void {
    if (watchedConnection !== connection) {
      stop?.();
      watchers = 0;
      overview.value = null;
      watchedConnection = connection;
      loading.value = true;
      stop = liveStream(`${base(connection)}/events`, AddonOverviewSchema, {
        state: (o) => {
          overview.value = o;
          error.value = null;
          loading.value = false;
        },
        error: (message) => {
          error.value = message;
          loading.value = false;
        },
        live: (on) => (live.value = on),
      });
    }
    watchers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      watchers--;
      if (watchers <= 0) {
        stop?.();
        stop = null;
        watchedConnection = null;
      }
    };
  }

  const matching = (connection: string, namespace: string, selector: Record<string, string>) =>
    api('POST', `${base(connection)}/matching`, z.array(z.string()), { namespace, selector });
  const preview = (connection: string, spec: AddonSpecInput) =>
    api('POST', `${base(connection)}/preview`, AddonPreviewSchema, { spec });
  const apply = (connection: string, spec: AddonSpecInput, takeOver: boolean) =>
    api('PUT', item(connection, spec.namespace, spec.name), AddonPreviewSchema, {
      spec,
      takeOver,
    });
  const deletePreview = (connection: string, namespace: string, name: string) =>
    api('GET', `${item(connection, namespace, name)}/delete-preview`, AddonDeletePreviewSchema);
  const remove = (connection: string, namespace: string, name: string) =>
    apiVoid('DELETE', item(connection, namespace, name));

  return { overview, error, live, loading, watch, matching, preview, apply, deletePreview, remove };
});
