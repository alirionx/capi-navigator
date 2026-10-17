import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  OPERATOR_GROUP,
  OPERATOR_VERSION,
  PROVIDER_KINDS,
  PROVIDER_PLURALS,
  type OperatorState,
} from '@capi-navigator/shared';
import type { Observable } from 'rxjs';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { LiveChannels, type LiveEvent } from '../kube/live-channels.js';
import { OperatorService } from './operator.service.js';

/** Watched paths: all provider kinds and all deployments (operator, ORC, provider controllers). */
const WATCH_PATHS = [
  ...PROVIDER_KINDS.map(
    (k) => `/apis/${OPERATOR_GROUP}/${OPERATOR_VERSION}/${PROVIDER_PLURALS[k]}`,
  ),
  '/apis/apps/v1/deployments',
];

export type OperatorEvent = LiveEvent<OperatorState>;

/** Live operator state per management cluster (FP3-F-13). */
@Injectable()
export class OperatorEventsService implements OnApplicationShutdown {
  private readonly live: LiveChannels<OperatorState>;

  constructor(operator: OperatorService, clients: ManagementClusterClients) {
    this.live = new LiveChannels('operator', {
      kubeConfig: (connection) => clients.forConnection(connection),
      paths: () => WATCH_PATHS,
      compute: (connection) => operator.state(connection),
    });
  }

  stream(connection: string): Observable<OperatorEvent> {
    return this.live.stream(connection);
  }

  onApplicationShutdown(): void {
    this.live.stopAll();
  }
}
