import { Controller, Get, Module, Param } from '@nestjs/common';
import type { ClusterNode } from '@capi-navigator/shared';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { Requires } from '../auth/decorators.js';
import { ClustersModule } from '../clusters/clusters.module.js';
import { ConnectionsModule } from '../connections/connections.module.js';
import { NodeShellGateway } from './node-shell.gateway.js';
import { NodeShellService } from './node-shell.service.js';

/** Nodes of a management cluster, e.g. to open a node shell (FP-17). */
@Controller('api/connections/:connection/nodes')
export class ManagementNodesController {
  constructor(private readonly shells: NodeShellService) {}

  @Requires('view')
  @Get()
  list(@Param('connection') connection: string): Promise<ClusterNode[]> {
    return this.shells.managementNodes(connection);
  }
}

/** FP-17: node shell via privileged pod, for workload and management cluster nodes. */
@Module({
  imports: [AuthModule, AuditModule, ConnectionsModule, ClustersModule],
  controllers: [ManagementNodesController],
  providers: [NodeShellService, NodeShellGateway],
})
export class NodeShellModule {}
