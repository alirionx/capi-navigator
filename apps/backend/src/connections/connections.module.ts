import { Module } from '@nestjs/common';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';
import { ManagementClusterClients } from './management-cluster-clients.js';

/** FP-2: management cluster connections. Exports the client factory for FP-3 and later. */
@Module({
  controllers: [ConnectionsController],
  providers: [ConnectionsService, ManagementClusterClients],
  exports: [ManagementClusterClients],
})
export class ConnectionsModule {}
