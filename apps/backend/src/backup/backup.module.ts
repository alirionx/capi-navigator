import { Module } from '@nestjs/common';
import { BackupController } from './backup.controller.js';
import { BackupSchedulerService } from './backup-scheduler.service.js';
import { BackupService } from './backup.service.js';

/** FP-38: backup of the home cluster, downloaded or scheduled to S3. */
@Module({
  controllers: [BackupController],
  providers: [BackupService, BackupSchedulerService],
})
export class BackupModule {}
