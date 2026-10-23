import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { AwsCredentialPlugin } from '../infra-providers/aws/aws-credential.plugin.js';
import { GcpCredentialPlugin } from '../infra-providers/gcp/gcp-credential.plugin.js';
import { OpenStackCredentialPlugin } from '../infra-providers/openstack/openstack-credential.plugin.js';
import { ProxmoxCredentialPlugin } from '../infra-providers/proxmox/proxmox-credential.plugin.js';
import { CredentialsController } from './credentials.controller.js';
import { CREDENTIAL_PLUGINS, CredentialsService } from './credentials.service.js';

/** FP-4: infrastructure credentials. Providers plug in via CREDENTIAL_PLUGINS (hard rule 10). */
@Module({
  imports: [ConnectionsModule],
  controllers: [CredentialsController],
  providers: [
    CredentialsService,
    {
      provide: CREDENTIAL_PLUGINS,
      useFactory: () => [
        new OpenStackCredentialPlugin(),
        new AwsCredentialPlugin(),
        new GcpCredentialPlugin(),
        new ProxmoxCredentialPlugin(),
      ],
    },
  ],
  exports: [CredentialsService],
})
export class CredentialsModule {}
