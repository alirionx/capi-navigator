import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { OperatorModule } from '../operator/operator.module.js';
import {
  ClusterEventsService,
  ClusterListEventsService,
  ClustersController,
} from './clusters.controller.js';
import { ClusterDeletionService } from './cluster-deletion.service.js';
import { ClustersService } from './clusters.service.js';

/** FP-5/FP-6: create workload clusters, live list and status, lifecycle. */
@Module({
  imports: [ConnectionsModule, CredentialsModule, OperatorModule],
  controllers: [ClustersController],
  providers: [
    ClustersService,
    ClusterEventsService,
    ClusterListEventsService,
    ClusterDeletionService,
  ],
})
export class ClustersModule {}
