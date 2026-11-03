# ADR-0035: Clusters from blueprints without a preview per request

- Status: accepted
- Date: 2026-11-03
- Pack: FP-34
- Refines: hard rule 6 (preview before apply), FP6-F-07 and FP-7 for blueprint clusters

## Context

An Open Service Broker for Cloud Foundry should let users order clusters of a few prepared
variants (outlook FP-35). The Cloud Controller calls the broker without a person in the loop, so a
preview per request cannot be shown or confirmed. Hard rule 6 asks for a preview before every
mutating action. The API already creates clusters directly; the preview is a step of the UI, but
there a person composed the spec and saw the YAML.

The broker should stay as simple as possible: a separate project that uses only the app's REST
API, keeps no state of its own and supports no updates in its first version.

## Decision

- **The blueprint is the reviewed preview.** An admin saves a `ClusterBlueprint` only after the
  app showed the generated YAML and a dry run with the default parameters passed (FP34-F-04).
  Creating a cluster from a blueprint then applies without a preview per request; the request can
  vary only the parameters the blueprint offers, within its limits (worker counts, machine sizes,
  Kubernetes version).
- **Concrete blueprints.** A blueprint fixes connection, namespace, credential, infrastructure
  provider, distribution and add-ons. Permission checks stay those of FP-19 (`clusters.create` in
  the blueprint's namespace), and one blueprint maps to one broker plan.
- **Blueprint clusters stay bound.** The backend refuses day-2 changes of a blueprint cluster
  except a Kubernetes upgrade by users with `blueprints.manage`, with preview. So a blueprint
  cluster never drifts away from what its blueprint describes through the app.
- **No versions in the first version.** Changing a blueprint affects only clusters created
  afterwards; existing clusters are not upgraded through their blueprint. A version field can be
  added later together with broker updates (`maintenance_info`).
- **Not ClusterClass.** Blueprints produce ordinary cluster specs and the same Cluster API
  objects as the wizard, so all existing transformations, snapshot tests and day-2 code apply;
  ClusterClass support stays in the outlook (FP-12).
- **The broker is not part of the app.** The Open Service Broker API, its authentication and its
  OpenAPI stay in a separate project; the app adds only what is useful without Cloud Foundry
  (blueprints, a label selector on the cluster list). Bindings return the existing admin
  kubeconfig (FP6-F-04), so hard rule 8 gets no new exception.

## Consequences

- A new CRD, a permission `blueprints.manage`, endpoints for blueprints and for creating from a
  blueprint, a blueprints page, and backend checks that refuse changes of blueprint clusters.
- Whoever may create from a blueprint gets a cluster without seeing its YAML; the admin who saved
  the blueprint is responsible for it. The audit log names the blueprint of every such cluster.
- Blueprint clusters cannot be scaled or relabelled; a user who needs a different cluster orders a
  new one. Clusters created from an older state of a blueprint keep that state until an admin
  upgrades their Kubernetes version.
- On Proxmox VE every cluster needs its own API, node and LoadBalancer addresses. A blueprint there
  carries an address pool, and every order gets free addresses of it (FP34-F-14, found in the
  live acceptance on 2026-11-03); orders of a connection are serialized in the backend. With
  several backend replicas two simultaneous orders could still pick the same addresses; the
  address check of the next change shows it.
- No limit on the number of clusters per blueprint in the first version; capacity stays with the
  admins (and plan visibility in Cloud Foundry).
