import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { KubeModule } from './kube/kube.module.js';

@Module({
  imports: [KubeModule, HealthModule],
})
export class AppModule {}
