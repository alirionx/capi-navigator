import { Logger } from '@nestjs/common';
import { Watch, type KubeConfig } from '@kubernetes/client-node';
import { Observable, type Subscriber } from 'rxjs';

const DEBOUNCE_MS = 400;
const RESTART_MS = 5000;
const IDLE_STOP_MS = 30_000;

export type LiveEvent<T> = { type: 'state'; state: T } | { type: 'error'; message: string };

interface Channel<T> {
  subscribers: Set<Subscriber<LiveEvent<T>>>;
  aborts: AbortController[];
  timer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  stopped: boolean;
  last?: string;
}

/**
 * Live state via server-sent events, fed by Kubernetes watches (NF-11): any watch event triggers
 * a debounced recomputation that is pushed to all subscribers of a channel. Dropped watches are
 * re-established; watches stop when nobody listens anymore. Used for FP3-F-13 and US-07.
 */
export class LiveChannels<T> {
  private readonly logger: Logger;
  private readonly channels = new Map<string, Channel<T>>();

  constructor(
    name: string,
    private readonly source: {
      kubeConfig(key: string): Promise<KubeConfig>;
      /** Watch paths; with `query` e.g. a fieldSelector for a single object. */
      paths(key: string): (string | { path: string; query: Record<string, string> })[];
      compute(key: string): Promise<T>;
    },
  ) {
    this.logger = new Logger(`LiveChannels(${name})`);
  }

  stream(key: string): Observable<LiveEvent<T>> {
    return new Observable<LiveEvent<T>>((subscriber) => {
      const channel = this.channel(key);
      channel.subscribers.add(subscriber);
      clearTimeout(channel.idleTimer);
      void this.push(key, channel, subscriber);
      return () => {
        channel.subscribers.delete(subscriber);
        if (channel.subscribers.size === 0) {
          channel.idleTimer = setTimeout(() => this.stop(key), IDLE_STOP_MS);
        }
      };
    });
  }

  stopAll(): void {
    for (const key of [...this.channels.keys()]) this.stop(key);
  }

  private channel(key: string): Channel<T> {
    let channel = this.channels.get(key);
    if (!channel) {
      channel = { subscribers: new Set(), aborts: [], stopped: false };
      this.channels.set(key, channel);
      for (const p of this.source.paths(key)) {
        const { path, query } = typeof p === 'string' ? { path: p, query: {} } : p;
        void this.watch(key, channel, path, query);
      }
    }
    return channel;
  }

  private async watch(
    key: string,
    channel: Channel<T>,
    path: string,
    query: Record<string, string> = {},
  ): Promise<void> {
    if (channel.stopped) return;
    const restart = () => {
      if (!channel.stopped)
        setTimeout(() => void this.watch(key, channel, path, query), RESTART_MS);
    };
    try {
      const kc = await this.source.kubeConfig(key);
      const abort = await new Watch(kc).watch(
        path,
        { allowWatchBookmarks: false, ...query },
        () => this.schedule(key, channel),
        (err?: unknown) => {
          // Missing CRDs end here too; retry until they exist.
          if (err) this.logger.debug(`Watch ${path} (${key}) ended: ${String(err)}`);
          restart();
        },
      );
      channel.aborts.push(abort);
    } catch (err) {
      this.logger.debug(`Watch ${path} (${key}) failed: ${String(err)}`);
      restart();
    }
  }

  private schedule(key: string, channel: Channel<T>): void {
    clearTimeout(channel.timer);
    channel.timer = setTimeout(() => void this.push(key, channel), DEBOUNCE_MS);
  }

  private async push(
    key: string,
    channel: Channel<T>,
    only?: Subscriber<LiveEvent<T>>,
  ): Promise<void> {
    let event: LiveEvent<T>;
    try {
      event = { type: 'state', state: await this.source.compute(key) };
    } catch (err) {
      const message =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'Cannot read the state';
      event = { type: 'error', message };
    }
    // Skip unchanged states for broadcasts; new subscribers always get the current one.
    const serialized = JSON.stringify(event);
    if (!only && serialized === channel.last) return;
    if (!only) channel.last = serialized;
    for (const s of only ? [only] : channel.subscribers) s.next(event);
  }

  private stop(key: string): void {
    const channel = this.channels.get(key);
    if (!channel) return;
    channel.stopped = true;
    clearTimeout(channel.timer);
    clearTimeout(channel.idleTimer);
    channel.aborts.forEach((a) => a.abort());
    this.channels.delete(key);
  }
}
