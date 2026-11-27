import { Module } from '@nestjs/common';
import { BackupController } from './backup.controller.js';
import { BackupService } from './backup.service.js';

/** FP-38: backup of the home cluster. */
@Module({
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}
