import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { OperatorModule } from '../operator/operator.module.js';
import { ClusterEventsService, ClustersController } from './clusters.controller.js';
import { ClustersService } from './clusters.service.js';

/** FP-5: create workload clusters; status view (FP-6 extends it). */
@Module({
  imports: [ConnectionsModule, CredentialsModule, OperatorModule],
  controllers: [ClustersController],
  providers: [ClustersService, ClusterEventsService],
})
export class ClustersModule {}
