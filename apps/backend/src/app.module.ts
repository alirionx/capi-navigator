import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ClustersModule } from './clusters/clusters.module.js';
import { ConfigModule } from './config/config.module.js';
import { ConnectionsModule } from './connections/connections.module.js';
import { CredentialsModule } from './credentials/credentials.module.js';
import { ResourcesModule } from './resources/resources.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { NodeShellModule } from './node-shell/node-shell.module.js';
import { HealthModule } from './health/health.module.js';
import { HelmModule } from './helm/helm.module.js';
import { KubeModule } from './kube/kube.module.js';
import { OperatorModule } from './operator/operator.module.js';
import { StoreModule } from './store/store.module.js';

@Module({
  imports: [
    ConfigModule,
    KubeModule,
    StoreModule,
    AuditModule,
    AuthModule,
    ConnectionsModule,
    OperatorModule,
    CredentialsModule,
    ClustersModule,
    NodeShellModule,
    DashboardModule,
    ResourcesModule,
    HelmModule,
    HealthModule,
  ],
})
export class AppModule {}
