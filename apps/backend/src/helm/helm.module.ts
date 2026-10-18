import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { AddonPresetsService } from './addon-presets.service.js';
import { AddonPresetsController, AddonsController } from './addons.controller.js';
import { AddonsService } from './addons.service.js';
import { HelmRepositoriesController } from './helm-repositories.controller.js';
import { HelmRepositoriesService } from './helm-repositories.service.js';

/** FP-8: Helm repositories and add-ons via CAAPH. */
@Module({
  imports: [ConnectionsModule],
  controllers: [HelmRepositoriesController, AddonsController, AddonPresetsController],
  providers: [HelmRepositoriesService, AddonsService, AddonPresetsService],
  exports: [HelmRepositoriesService, AddonsService],
})
export class HelmModule {}
