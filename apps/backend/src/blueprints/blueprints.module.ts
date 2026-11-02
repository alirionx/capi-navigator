import { Module } from '@nestjs/common';
import { ClustersModule } from '../clusters/clusters.module.js';
import { BlueprintsController } from './blueprints.controller.js';
import { BlueprintsService } from './blueprints.service.js';

/** FP-34: cluster blueprints and creating clusters from them. */
@Module({
  imports: [ClustersModule],
  controllers: [BlueprintsController],
  providers: [BlueprintsService],
})
export class BlueprintsModule {}
