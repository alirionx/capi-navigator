import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  BackupPreviewSchema,
  BackupRunSchema,
  BackupS3TestResultSchema,
  BackupSettingsSchema,
  ManagementBackupPreviewSchema,
  type BackupPreview,
  type BackupRun,
  type BackupS3TestRequest,
  type BackupS3TestResult,
  type BackupSettings,
  type BackupSettingsInput,
  type ManagementBackupPreview,
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

  /** FP38-F-14: test the target as entered. */
  function testS3(req: BackupS3TestRequest): Promise<BackupS3TestResult> {
    return api('POST', '/api/backup/s3/test', BackupS3TestResultSchema, req);
  }

  /** FP38-F-14: back up to S3 now; the runs are reloaded either way. */
  async function runS3(): Promise<BackupRun> {
    try {
      return await api('POST', '/api/backup/s3/run', BackupRunSchema);
    } finally {
      settings.value = await api('GET', '/api/backup/settings', BackupSettingsSchema);
    }
  }

  /** FP39-F-09: what a backup of a management cluster would contain now. */
  function managementPreview(connection: string): Promise<ManagementBackupPreview> {
    return api(
      'GET',
      `/api/backup/management/${encodeURIComponent(connection)}/preview`,
      ManagementBackupPreviewSchema,
    );
  }

  /** FP39-F-01: downloads the encrypted backup of a management cluster; returns the file name. */
  function downloadManagement(connection: string): Promise<string> {
    return apiDownload(
      `/api/backup/management/${encodeURIComponent(connection)}`,
      `capi-navigator-mgmt-${connection}.tar.gz.gpg`,
    );
  }

  return {
    settings,
    preview,
    load,
    save,
    download,
    testS3,
    runS3,
    managementPreview,
    downloadManagement,
  };
});
