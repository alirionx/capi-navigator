import { Module } from '@nestjs/common';
import { ClustersModule } from '../clusters/clusters.module.js';
import { HelmModule } from '../helm/helm.module.js';
import { NamespacesController } from './namespaces.controller.js';
import { NamespacesService } from './namespaces.service.js';

/** FP-36: managed namespaces and service accounts in workload clusters. */
@Module({
  imports: [ClustersModule, HelmModule],
  controllers: [NamespacesController],
  providers: [NamespacesService],
})
export class NamespacesModule {}
