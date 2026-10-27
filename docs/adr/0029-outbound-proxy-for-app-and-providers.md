# ADR-0029: Outbound proxy for the app and the provider controllers

- Status: accepted
- Date: 2026-10-27
- Pack: FP-29 (part A)
- Refines: the FP-16 outlook (operation behind a proxy, stages b and c), FP-3 (provider management)

## Context

In air-gapped setups (FP-29) the workload cluster nodes reach no internet, but the app and the
management cluster do, through an HTTP(S) proxy that often inspects TLS. Three parties go out:
the app (GitHub releases, the ORC manifest, Helm repositories), the CAPI Operator (provider
components from GitHub) and some provider controllers (CAAPH for Helm repositories, CAPA and CAPG
for the public cloud APIs). They differ in two ways that matter:

- The app is Node.js: it honours the proxy variables only with `NODE_USE_ENV_PROXY=1`, its
  `NO_PROXY` takes IP ranges `a-b` but no CIDRs (and `fetch` not even ranges), and a proxy CA goes
  into `NODE_EXTRA_CA_CERTS`. The controllers are Go: `NO_PROXY` takes CIDRs but no ranges, and
  client-go sends its own calls to the API server through the proxy unless its ClusterIP is
  excluded.
- The app and the CAPI Operator are installed with Helm by the admin; the provider controllers are
  installed by the app through provider CRs of the CAPI Operator.

Options considered:

1. **Proxy settings of the app reused for the controllers.** One place to configure, but the
   `NO_PROXY` syntaxes differ, the CA would have to be read from the app's own file system, and
   every management cluster would get the same proxy.
2. **Proxy per management cluster connection, applied to selected providers.** The app's own
   proxy stays a deployment setting (Helm values); each connection stores the proxy its
   controllers use, in Go syntax.
3. **Proxy for all providers of a connection.** Simpler, but controllers that only talk to the
   API server or to an internal cloud (core, bootstrap, control plane, CAPO, CAPMOX, IPAM) gain
   nothing, and an incomplete `NO_PROXY` would break their access to an internal OpenStack or
   Proxmox VE API.

For the CA of a proxy that inspects TLS, `SSL_CERT_FILE` replaces the system trust store of a Go
program, while `SSL_CERT_DIR` adds a directory to it.

## Decision

- **The app** reads the standard variables: the image sets `NODE_USE_ENV_PROXY=1`, the chart
  passes `extraEnv`, `extraVolumes` and `extraVolumeMounts` through, and the CA goes in with
  `NODE_EXTRA_CA_CERTS`. The CAPI Operator is configured the same way through its own chart
  (`env.manager`, `volumes`, `volumeMounts.manager`); the README shows both.
- **Option 2 for the controllers.** A connection has an optional outbound proxy (HTTPS and HTTP
  proxy, `NO_PROXY`, CA), without credentials and therefore stored in the `ManagementCluster`
  resource. Each provider has a switch, on by default where the catalog says the controller needs
  the internet (CAAPH, CAPA, CAPG).
- **Delivery through the provider CR**: the proxy variables in `spec.deployment.containers[].env`,
  the CA as Secret `capi-navigator-proxy-ca` in the provider namespace, mounted by a JSON patch in
  `spec.patches`, and named in `SSL_CERT_DIR` so the public CAs stay valid. The app adds
  `localhost`, `127.0.0.1`, `.svc`, `.cluster.local` and the ClusterIP of `default/kubernetes` to
  `NO_PROXY`. A hash of the settings is set as environment variable (restart on change) and as
  annotation `capi-navigator.io/outbound-proxy` (outdated providers are shown).
- **Changes apply on the next update of a provider**, after the usual preview; switching the proxy
  off removes the environment, the patch and the app's CA Secret.

## Consequences

- The proxy of the app and the proxy of each management cluster are configured in two places,
  with two `NO_PROXY` syntaxes; the forms and the README name the syntax that applies.
- Users must add the networks of the workload clusters' API endpoints to `NO_PROXY`, unless the
  proxy reaches them: CAAPH installs the charts through those endpoints.
- A changed proxy does not reach running controllers until their providers are updated; the
  providers page lists the affected ones.
- The CA patch assumes one Deployment per provider with the manager as first container, which
  holds for every catalog provider today; a provider that breaks it needs a target with a name.
- Workload clusters behind a proxy (FP-16 stage a) and nodes without internet (FP-29 part B) are
  not covered by this decision.
