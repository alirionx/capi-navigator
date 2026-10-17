import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ConfigModule } from './config/config.module.js';
import { ConnectionsModule } from './connections/connections.module.js';
import { HealthModule } from './health/health.module.js';
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
    HealthModule,
  ],
})
export class AppModule {}
