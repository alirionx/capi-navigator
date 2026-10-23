import type { Component } from 'vue';
import type { CredentialProvider } from '@capi-navigator/shared';
import AwsCredentialFields from './AwsCredentialFields.vue';
import GcpCredentialFields from './GcpCredentialFields.vue';
import MachineSizesEditor from './MachineSizesEditor.vue';
import OpenStackCredentialFields from './OpenStackCredentialFields.vue';
import ProxmoxCredentialFields from './ProxmoxCredentialFields.vue';

/**
 * Secret part of the credential form per provider (FP25-F-05, ADR-0021). Each component emits
 * the provider's input as the API expects it. The only place in the frontend that names
 * providers, besides the i18n texts.
 */
export const CREDENTIAL_FIELDS: Record<CredentialProvider, Component> = {
  openstack: OpenStackCredentialFields,
  aws: AwsCredentialFields,
  gcp: GcpCredentialFields,
  proxmox: ProxmoxCredentialFields,
};

/**
 * Settings of a credential that are not secret (FP31-F-04), editable without entering the secret
 * again. Each component emits an object merged into the request, or null while invalid.
 */
export const CREDENTIAL_SETTINGS: Partial<Record<CredentialProvider, Component>> = {
  proxmox: MachineSizesEditor,
};
