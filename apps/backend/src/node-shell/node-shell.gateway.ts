import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  allows,
  ShellClientMessageSchema,
  type Permission,
  type PermissionScope,
  type RolePermissions,
} from '@capi-navigator/shared';
import type { Request } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Principal } from '../auth/principal.js';
import { SessionService } from '../auth/session.service.js';
import { StoreService } from '../store/store.service.js';
import { NodeShellService, type ShellPeer, type ShellTarget } from './node-shell.service.js';

/**
 * WebSocket entry of the node shell (FP-17):
 *   /api/connections/:connection/clusters/:namespace/:name/nodes/:node/shell  (nodes.shell)
 *   /api/connections/:connection/nodes/:node/shell                            (managementNodes.shell)
 * The upgrade is checked like the REST API: session cookie, permission in the cluster's
 * connection and namespace (FP19-F-05), and same-origin (CSRF).
 */
const WORKLOAD = /^\/api\/connections\/([^/]+)\/clusters\/([^/]+)\/([^/]+)\/nodes\/([^/]+)\/shell$/;
const MANAGEMENT = /^\/api\/connections\/([^/]+)\/nodes\/([^/]+)\/shell$/;

export interface ShellRoute {
  target: ShellTarget;
  permission: Permission;
  scope: PermissionScope;
}

export function parseShellRoute(pathname: string): ShellRoute | undefined {
  const d = (s: string) => decodeURIComponent(s);
  const w = WORKLOAD.exec(pathname);
  if (w) {
    return {
      target: {
        kind: 'workload',
        connection: d(w[1]!),
        namespace: d(w[2]!),
        cluster: d(w[3]!),
        node: d(w[4]!),
      },
      permission: 'nodes.shell',
      scope: { connection: d(w[1]!), namespace: d(w[2]!) },
    };
  }
  const m = MANAGEMENT.exec(pathname);
  if (m) {
    // Root on the management cluster endangers all workload clusters (ADR-0008).
    return {
      target: { kind: 'management', connection: d(m[1]!), node: d(m[2]!) },
      permission: 'managementNodes.shell',
      scope: { connection: d(m[1]!) },
    };
  }
  return undefined;
}

/** Decides whether an upgrade may proceed; returns the HTTP status to answer otherwise. */
export function checkUpgrade(
  req: IncomingMessage,
  principal: Principal | undefined,
  route: ShellRoute,
  rolePermissions: RolePermissions,
): number | undefined {
  const origin = req.headers.origin;
  const host = req.headers.host;
  // Browsers always send Origin on WebSocket requests; it must be this host (CSRF, NF-04).
  if (!origin || !host || new URL(origin).host !== host) return 403;
  if (!principal) return 401;
  if (principal.mustChangePassword) return 403;
  if (!allows(principal.bindings, rolePermissions, route.permission, route.scope)) return 403;
  return undefined;
}

@Injectable()
export class NodeShellGateway implements OnApplicationBootstrap {
  private readonly logger = new Logger(NodeShellGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly sessions: SessionService,
    private readonly shells: NodeShellService,
    private readonly store: StoreService,
  ) {}

  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as
      | {
          on(
            event: 'upgrade',
            fn: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
          ): void;
        }
      | undefined;
    server?.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const route = parseShellRoute(pathname);
    if (!route) return; // other upgrades (none today) are not ours
    const principal = this.sessions.authenticate(req as Request);
    const denied = checkUpgrade(req, principal, route, this.store.rolePermissions);
    if (denied) {
      socket.write(`HTTP/1.1 ${denied} ${denied === 401 ? 'Unauthorized' : 'Forbidden'}\r\n\r\n`);
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      void this.shells.run(principal!, route.target, peerFor(ws)).catch((err: unknown) => {
        this.logger.warn(`Node shell session failed: ${String(err)}`);
        ws.close(1011, 'failed');
      });
    });
  }
}

/** Adapts a WebSocket to the session: binary frames carry output, JSON text frames control. */
function peerFor(ws: WebSocket): ShellPeer {
  return {
    sendOutput: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
    },
    sendControl: (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    close: (code, reason) => ws.close(code, reason),
    onMessage: (handler) =>
      ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        try {
          const parsed = ShellClientMessageSchema.safeParse(JSON.parse(String(raw)));
          if (parsed.success) handler(parsed.data);
        } catch {
          // ignore malformed frames
        }
      }),
    onClose: (handler) => ws.on('close', handler),
  };
}
