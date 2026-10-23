import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { OperatorEventsService } from './operator-events.service.js';
import { OperatorController } from './operator.controller.js';
import { OperatorService } from './operator.service.js';

/** FP-3: CAPI Operator, ORC and provider management. */
@Module({
  imports: [ConnectionsModule, CredentialsModule],
  controllers: [OperatorController],
  providers: [OperatorService, OperatorEventsService],
  exports: [OperatorService],
})
export class OperatorModule {}
