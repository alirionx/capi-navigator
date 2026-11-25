import { Injectable, NotFoundException } from '@nestjs/common';
import {
  personKey,
  type ManagedNamespaceSpec,
  type MyNamespace,
  type MyNamespaces,
  type NamespaceTokenResponse,
} from '@capi-navigator/shared';
import type { Principal } from '../auth/principal.js';
import { AddonsService } from '../helm/addons.service.js';
import { StoreService } from '../store/store.service.js';
import { NamespacesService, withTimeout, type ClusterRef } from './namespaces.service.js';
import { PeopleService } from './people.service.js';

const LIST_TIMEOUT_MS = 10_000;

/** A namespace of a workload cluster as the routes name it. */
export interface MyNamespaceRef extends ClusterRef {
  workloadNamespace: string;
}

/**
 * Self-service of the people assigned to a managed namespace (FP-37, ADR-0041). Everything follows
 * from the assignments, checked on every request; whatever is not assigned looks like something
 * that does not exist.
 */
@Injectable()
export class MyNamespacesService {
  constructor(
    private readonly store: StoreService,
    private readonly addons: AddonsService,
    private readonly namespaces: NamespacesService,
    private readonly people: PeopleService,
  ) {}

  /** FP37-F-03: the assigned namespaces of all connections. */
  async list(principal: Principal): Promise<MyNamespaces> {
    const keys = this.people.keys(principal);
    const self = this.people.identity(principal);
    if (!self) return { namespaces: [], incomplete: false };
    let incomplete = false;
    const found = await Promise.all(
      this.store.connectionCache.list().map(async (c): Promise<MyNamespace[]> => {
        const connection = c.metadata.name;
        let defined;
        try {
          defined = await withTimeout(this.addons.namespaceAddons(connection), LIST_TIMEOUT_MS);
        } catch {
          incomplete = true;
          return [];
        }
        return Promise.all(
          defined.flatMap(({ spec, status }) => {
            const accounts = assignedAccounts(spec, keys);
            if (!accounts.length) return [];
            return status.matchingClusters.map((name) =>
              this.namespaces.forPerson(
                { connection, namespace: spec.namespace, name },
                spec,
                status,
                accounts,
                self,
              ),
            );
          }),
        );
      }),
    );
    return {
      namespaces: found
        .flat()
        .sort((a, b) =>
          `${a.cluster}/${a.namespace}/${a.connection}`.localeCompare(
            `${b.cluster}/${b.namespace}/${b.connection}`,
          ),
        ),
      incomplete,
    };
  }

  /** FP37-F-04, F-06: a token for an assigned account, limited in number. */
  async issueToken(
    principal: Principal,
    ref: MyNamespaceRef,
    account: string,
    req: { lifetimeSeconds: number; format: 'token' | 'kubeconfig' },
  ): Promise<NamespaceTokenResponse> {
    const { self, spec, keys } = await this.assigned(principal, ref);
    const granted = spec.accounts.find((a) => a.name === account);
    const grant = granted?.people.map(personKey).find((k) => keys.includes(k));
    if (!grant) throw notFound();
    return this.namespaces.issueToken(ref, ref.workloadNamespace, account, req, {
      name: principal.username,
      id: self,
      grant,
    });
  }

  /** FP37-F-04: only tokens the person issued. */
  async revokeToken(principal: Principal, ref: MyNamespaceRef, token: string): Promise<void> {
    const { self } = await this.assigned(principal, ref);
    await this.namespaces.revokeToken(ref, ref.workloadNamespace, token, self);
  }

  /** The same answer for a name that does not exist and for one that is not assigned. */
  private async assigned(principal: Principal, ref: MyNamespaceRef) {
    const keys = this.people.keys(principal);
    const self = this.people.identity(principal);
    if (!self || !this.store.connectionCache.get(ref.connection)) throw notFound();
    let defined;
    try {
      defined = await withTimeout(
        this.addons.namespaceAddons(ref.connection, ref.namespace),
        LIST_TIMEOUT_MS,
      );
    } catch {
      // Also when the management cluster does not answer: the error would reveal that it exists.
      throw notFound();
    }
    const spec = defined.find(
      (d) =>
        d.spec.name === ref.workloadNamespace &&
        d.status.matchingClusters.includes(ref.name) &&
        assignedAccounts(d.spec, keys).length > 0,
    )?.spec;
    if (!spec) throw notFound();
    return { self, keys, spec };
  }
}

const assignedAccounts = (spec: ManagedNamespaceSpec, keys: string[]) =>
  spec.accounts.filter((a) => a.people.some((p) => keys.includes(personKey(p))));

const notFound = () =>
  new NotFoundException({
    statusCode: 404,
    message: 'Not found',
    hint: 'It does not exist, is not assigned to you or is not available right now.',
  });
