# Managed namespaces

The owner of a workload cluster can divide it into namespaces and give teams limited access to
them (FP-36). Ordering whole clusters stays as it is; the admin kubeconfig remains the access to
the whole cluster. Decisions: [ADR-0039](adr/0039-namespaces-as-add-ons.md),
[ADR-0040](adr/0040-tokens-for-namespaces.md).

## What a namespace gets

A namespace is created from a form on the page of the cluster (tab Namespaces) and rolled out as
an add-on through CAAPH. It contains:

| Guard rail         | What it does                                                                   |
| ------------------ | ------------------------------------------------------------------------------ |
| Size (quota)       | Limits CPU, memory, pods, volumes, storage and load balancers of the namespace |
| Container defaults | Requests 100m CPU and 128 MiB, limits 500m CPU and 512 MiB                     |
| Isolation          | Pods of other namespaces are blocked, except namespaces named in the form      |
| Pod Security       | `baseline` is enforced, `restricted` only warns                                |

Sizes (the values can be adjusted per namespace):

| Size   | CPU requests / limits | Memory requests / limits | Pods | Volumes / storage | Load balancers |
| ------ | --------------------- | ------------------------ | ---- | ----------------- | -------------- |
| small  | 2 / 4                 | 4 / 8 GiB                | 20   | 5 / 20 GiB        | 1              |
| medium | 4 / 8                 | 8 / 16 GiB               | 50   | 10 / 50 GiB       | 2              |
| large  | 8 / 16                | 16 / 32 GiB              | 100  | 20 / 100 GiB      | 4              |

Outgoing traffic is allowed. Teams may add their own NetworkPolicies to be stricter.

## Accounts and access

An account is a service account with the role `view` or `edit` in this one namespace. The accounts
live in the namespace `capi-navigator-accounts`, where teams have no rights.

**Get access** issues a token or a kubeconfig, valid for at most 7 days. It is shown once and not
stored by the app. Kubernetes allows one minute of leeway after the expiry. Issued access is listed with creator and expiry and can be revoked one by one;
it then stops working within seconds. Needs the permission `clusters.access` (operator and admin).

## Self-service

People can get their access themselves (FP-37, [ADR-0041](adr/0041-namespace-users-without-view.md)).

1. **Assign** them in the namespace form, per account: local users, groups or single sign-on people.
   Groups must be mapped in the app. Assigning does not change anything in the cluster.
2. They open **My namespaces** and issue a kubeconfig or token, at most five valid ones per account.
   They see only their own namespaces and their own access, and can revoke it.

People who should see nothing else get the built-in role **Namespace user**. It is the only role that
cannot read: no clusters, no add-ons, no settings. Self-service works with every other role too. For
single sign-on, set Namespace user as role of a group or as default role; the default role is Viewer
otherwise.

**Removing a person** takes effect at once for new access. Access already issued stays valid until
it expires; the Namespaces tab shows it and offers to revoke it. Group membership comes from the
sign-in, so a person removed from a group at the provider keeps it until the session ends.

## Changes, removal, deletion

- **Edit** changes size, exceptions and accounts after a preview. Name and clusters are fixed.
- **Changed in the cluster**: somebody changed the guard rails directly. **Restore** sets them
  back. Other objects of the namespace, e.g. Deployments, are never touched.
- **End access** removes the accounts; all issued access becomes invalid. The namespace stays with
  its data, limits and isolation. The same happens when a cluster loses the labels that selected
  it. **Give access again** takes the namespace over.
- **Delete namespace** deletes it with everything in it. Only after the access was ended.

## Through the API

```bash
B=https://navigator.example.com/api/connections/home/clusters/team/prod/namespaces
curl -H "Authorization: Bearer $TOKEN" $B
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"format":"kubeconfig","lifetimeSeconds":86400}' $B/team-a/accounts/ci/tokens
```

All operations are in the OpenAPI document (Swagger UI).

## Limits

- Only for clusters with Calico, which all distributions of the app use today. Not for clusters
  created outside the app and not for clusters from a blueprint.
- The isolation is as strong as quota, Calico policy and Pod Security. It does not replace a
  multi-tenancy platform or separate clusters for teams that do not trust each other.
- A Service that a team exposes through a NodePort or load balancer is reachable for everybody,
  also for pods of other namespaces.
- Rolling one definition out to several clusters: ending the access applies to all of them.
