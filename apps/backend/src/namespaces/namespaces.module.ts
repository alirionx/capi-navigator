import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ClustersModule } from '../clusters/clusters.module.js';
import { HelmModule } from '../helm/helm.module.js';
import { MyNamespacesController } from './my-namespaces.controller.js';
import { MyNamespacesService } from './my-namespaces.service.js';
import { NamespacesController } from './namespaces.controller.js';
import { NamespacesService } from './namespaces.service.js';
import { PeopleService } from './people.service.js';

/** FP-36: managed namespaces and service accounts in workload clusters; FP-37: self-service. */
@Module({
  imports: [AuthModule, ClustersModule, HelmModule],
  controllers: [NamespacesController, MyNamespacesController],
  providers: [NamespacesService, MyNamespacesService, PeopleService],
})
export class NamespacesModule {}
