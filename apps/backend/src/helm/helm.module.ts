import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { HelmRepositoriesController } from './helm-repositories.controller.js';
import { HelmRepositoriesService } from './helm-repositories.service.js';

/** FP-8: Helm repositories and add-ons via CAAPH. */
@Module({
  imports: [ConnectionsModule],
  controllers: [HelmRepositoriesController],
  providers: [HelmRepositoriesService],
  exports: [HelmRepositoriesService],
})
export class HelmModule {}
