# ADR-0021: Provider forms described by the infrastructure plugins

- Status: accepted
- Date: 2026-10-20
- Pack: FP-25
- Refines: FP25-F-05

## Context

With OpenStack and AWS, the frontend had grown about 50 checks like `provider === 'openstack'`:
the wizard kept one draft object per provider, the machine group, bastion, detail and day-2 views
chose lookups, hints and rules by provider, and the credential dialog held all three secret
forms. A third provider (Google Cloud) would have added a branch in each place. FP25-F-05 asks
for the forms to be described by the plugins and for a frontend without provider checks.

The forms differ in two ways. The infrastructure step, machine groups and bastion are simple
fields: a value, a selection list from the credential, a default, a hint that names the CAPI
field. The secret part of a credential is not: OpenStack parses an uploaded `clouds.yaml` on the
server and offers its clouds, offers a form with two authentication types and a CA certificate;
Google Cloud reads a JSON key file and shows its project.

## Decision

- **Descriptions in the shared plugins.** `InfraTransformPlugin` gains `form` (`InfraForm` in
  `packages/shared/src/cluster/infra-form.ts`): the fields of the infrastructure step (spec path,
  kind, lookup or fixed options, default, preselection from a list, initial value from the
  credential, fields that a change resets), the lookups to load, notes, the key pair field, the
  machine size lookup and the root disk rules, and the bastion (size required, source networks,
  warnings, SSH user, the credential check that breaks it). Labels and hints are i18n keys, so
  texts stay in vue-i18n; hints keep naming the CAPI resource and field (POS-04).
- **Generic helpers, generic views.** `infraFromValues`, `bastionRequest` and `bastionComplete`
  turn form values into the spec; `InfraFields.vue` renders the fields. The wizard, machine group
  and bastion editors, the detail view and the day-2 configuration only read the description.
  Validation labels of infrastructure fields come from the form, too.
- **Credential secrets as components.** The secret part of the credential dialog is one Vue
  component per provider, registered in `components/credentials/index.ts`. A description would
  need custom field kinds for each of them and hide little. The dialog renders the registered
  component; the credential list shows the summary through one i18n text per provider.
- **A test keeps it that way.** `provider-neutral.test.ts` fails if a provider name appears as a
  string in the frontend outside the i18n texts and the credential component registry.

## Consequences

- A new infrastructure provider needs a plugin with its form description, a credential component,
  i18n texts and a backend credential plugin; the generic views stay untouched.
- The wizard keeps one value set per provider, so switching providers keeps the entries, as
  before. Changing the credential now resets every field that comes from it or its lists (before:
  image and region only), so no value of another cloud survives.
- Forms that a description cannot express (for example a field that depends on two others) need
  a new descriptor kind; that is a deliberate step, not a quick `if`.
