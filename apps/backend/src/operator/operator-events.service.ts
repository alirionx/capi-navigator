import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Watch } from '@kubernetes/client-node';
import {
  OPERATOR_GROUP,
  OPERATOR_VERSION,
  PROVIDER_KINDS,
  PROVIDER_PLURALS,
  type OperatorState,
} from '@capi-navigator/shared';
import { Observable, type Subscriber } from 'rxjs';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { OperatorService } from './operator.service.js';

const DEBOUNCE_MS = 400;
const RESTART_MS = 5000;
const IDLE_STOP_MS = 30_000;

/** Watched paths: all provider kinds and all deployments (operator, ORC, provider controllers). */
const WATCH_PATHS = [
  ...PROVIDER_KINDS.map(
    (k) => `/apis/${OPERATOR_GROUP}/${OPERATOR_VERSION}/${PROVIDER_PLURALS[k]}`,
  ),
  '/apis/apps/v1/deployments',
];

export type OperatorEvent =
  { type: 'state'; state: OperatorState } | { type: 'error'; message: string };

interface Channel {
  subscribers: Set<Subscriber<OperatorEvent>>;
  aborts: AbortController[];
  timer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  stopped: boolean;
}

/**
 * Live operator state per management cluster (FP3-F-13). Kubernetes watches trigger a debounced
 * refresh that is pushed to all subscribers via server-sent events; dropped watches are
 * re-established automatically (NF-11). Watches stop when nobody listens.
 */
@Injectable()
export class OperatorEventsService implements OnApplicationShutdown {
  private readonly logger = new Logger(OperatorEventsService.name);
  private readonly channels = new Map<string, Channel>();

  constructor(
    private readonly operator: OperatorService,
    private readonly clients: ManagementClusterClients,
  ) {}

  stream(connection: string): Observable<OperatorEvent> {
    return new Observable<OperatorEvent>((subscriber) => {
      const channel = this.channel(connection);
      channel.subscribers.add(subscriber);
      clearTimeout(channel.idleTimer);
      void this.push(connection, channel, subscriber);
      return () => {
        channel.subscribers.delete(subscriber);
        if (channel.subscribers.size === 0) {
          channel.idleTimer = setTimeout(() => this.stop(connection), IDLE_STOP_MS);
        }
      };
    });
  }

  onApplicationShutdown(): void {
    for (const name of [...this.channels.keys()]) this.stop(name);
  }

  private channel(connection: string): Channel {
    let channel = this.channels.get(connection);
    if (!channel) {
      channel = { subscribers: new Set(), aborts: [], stopped: false };
      this.channels.set(connection, channel);
      for (const path of WATCH_PATHS) void this.watch(connection, channel, path);
    }
    return channel;
  }

  private async watch(connection: string, channel: Channel, path: string): Promise<void> {
    if (channel.stopped) return;
    const restart = () => {
      if (!channel.stopped)
        setTimeout(() => void this.watch(connection, channel, path), RESTART_MS);
    };
    try {
      const kc = await this.clients.forConnection(connection);
      const abort = await new Watch(kc).watch(
        path,
        { allowWatchBookmarks: false },
        () => this.schedule(connection, channel),
        (err?: unknown) => {
          // A missing CRD (operator not installed yet) also ends here; retry until it exists.
          if (err) this.logger.debug(`Watch ${path} on ${connection} ended: ${String(err)}`);
          restart();
        },
      );
      channel.aborts.push(abort);
    } catch (err) {
      this.logger.debug(`Watch ${path} on ${connection} failed: ${String(err)}`);
      restart();
    }
  }

  private schedule(connection: string, channel: Channel): void {
    clearTimeout(channel.timer);
    channel.timer = setTimeout(() => void this.push(connection, channel), DEBOUNCE_MS);
  }

  private async push(
    connection: string,
    channel: Channel,
    only?: Subscriber<OperatorEvent>,
  ): Promise<void> {
    let event: OperatorEvent;
    try {
      event = { type: 'state', state: await this.operator.state(connection) };
    } catch (err) {
      const message =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'Cannot read the operator state';
      event = { type: 'error', message };
    }
    for (const s of only ? [only] : channel.subscribers) s.next(event);
  }

  private stop(connection: string): void {
    const channel = this.channels.get(connection);
    if (!channel) return;
    channel.stopped = true;
    clearTimeout(channel.timer);
    clearTimeout(channel.idleTimer);
    channel.aborts.forEach((a) => a.abort());
    this.channels.delete(connection);
  }
}
