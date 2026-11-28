import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { BackupController } from './backup.controller.js';
import { BackupSchedulerService } from './backup-scheduler.service.js';
import { BackupService } from './backup.service.js';
import { ManagementBackupService } from './management-backup.service.js';

/**
 * FP-38: backup of the home cluster, downloaded or scheduled to S3. FP-39: backup of the
 * management clusters.
 */
@Module({
  imports: [ConnectionsModule],
  controllers: [BackupController],
  providers: [BackupService, BackupSchedulerService, ManagementBackupService],
})
export class BackupModule {}
