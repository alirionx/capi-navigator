import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  BackupPreviewSchema,
  BackupSettingsSchema,
  type BackupPreview,
  type BackupSettings,
  type BackupSettingsInput,
} from '@capi-navigator/shared';
import { api, apiDownload } from '../api/client.js';

/** Backup page (FP38-F-09); needs backup.manage. */
export const useBackupStore = defineStore('backup', () => {
  const settings = ref<BackupSettings | null>(null);
  const preview = ref<BackupPreview | null>(null);

  async function load(): Promise<void> {
    const [s, p] = await Promise.all([
      api('GET', '/api/backup/settings', BackupSettingsSchema),
      api('GET', '/api/backup/preview', BackupPreviewSchema),
    ]);
    settings.value = s;
    preview.value = p;
  }

  async function save(input: BackupSettingsInput): Promise<void> {
    settings.value = await api('PUT', '/api/backup/settings', BackupSettingsSchema, input);
    preview.value = await api('GET', '/api/backup/preview', BackupPreviewSchema);
  }

  /** Downloads an encrypted backup; returns the file name. */
  function download(): Promise<string> {
    return apiDownload('/api/backup', 'capi-navigator-home.tar.gz.gpg');
  }

  return { settings, preview, load, save, download };
});
