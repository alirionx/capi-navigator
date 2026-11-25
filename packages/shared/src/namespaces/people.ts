import { z } from 'zod';
import { OidcGroupNameSchema, OidcSubjectSchema } from '../crds/navigator-group.js';

/**
 * People who may issue tokens for a service account of a managed namespace themselves (FP37-F-02,
 * ADR-0041). A name alone is never the identity: local users carry the UID of their `NavigatorUser`,
 * OIDC people and groups their issuer.
 */
export const NamespacePersonSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    name: z.string().min(1).max(63),
    uid: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal('person'),
    issuer: z.string().min(1).max(512),
    subject: OidcSubjectSchema,
    /** Only for display. */
    displayName: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal('group'),
    issuer: z.string().min(1).max(512),
    group: OidcGroupNameSchema,
  }),
]);
export type NamespacePerson = z.infer<typeof NamespacePersonSchema>;

/**
 * Pure: the identity an assignment stands for. The whole strings are compared, no hash; an issuer is
 * a URL without fragment, so `#` separates it without ambiguity.
 */
export function personKey(p: NamespacePerson): string {
  switch (p.kind) {
    case 'user':
      return `user:${p.uid}`;
    case 'person':
      return `person:${p.issuer}#${p.subject}`;
    case 'group':
      return `group:${p.issuer}#${p.group}`;
  }
}

/** What people are shown as, e.g. in the form. */
export const personLabel = (p: NamespacePerson): string =>
  p.kind === 'user' ? p.name : p.kind === 'group' ? p.group : (p.displayName ?? p.subject);

/** The reduced list the cluster owner picks from: no roles, no technical users (FP37-F-02). */
export const AssignablePeopleSchema = z.array(NamespacePersonSchema);
export type AssignablePeople = z.infer<typeof AssignablePeopleSchema>;
