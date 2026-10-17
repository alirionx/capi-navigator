import { Global, Module } from '@nestjs/common';
import { KubeClientFactory } from './kube-client.factory.js';

@Global()
@Module({
  providers: [KubeClientFactory],
  exports: [KubeClientFactory],
})
export class KubeModule {}
