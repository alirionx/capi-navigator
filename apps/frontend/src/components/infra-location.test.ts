import type { Credential } from '@capi-navigator/shared';
import { describe, expect, it } from 'vitest';
import { infraLocation } from './infra-location.js';

const cred = (provider: Credential['provider'], name: string, summary: Credential['summary']) =>
  ({ provider, name, summary }) as Credential;

describe('where a cluster runs (UX-08)', () => {
  const creds = [
    cred('openstack', 'infomaniak', { region: 'dc4-a', cloudName: 'infomaniak' }),
    cred('gcp', 'gcp', { projectId: 'my-project' }),
  ];

  it('takes the region of an OpenStack credential', () => {
    expect(infraLocation({ provider: 'openstack', credential: 'infomaniak' }, creds)).toBe(
      'infomaniak · dc4-a',
    );
  });

  it('prefers the location of the spec (region, node)', () => {
    expect(
      infraLocation({ provider: 'aws', credential: 'aws', location: 'eu-central-1' }, creds),
    ).toBe('aws · eu-central-1');
    expect(
      infraLocation({ provider: 'proxmox', credential: 'pve', location: 'homeserver' }, []),
    ).toBe('pve · homeserver');
  });

  it('shows the name alone without the credential, nothing without a stored spec', () => {
    expect(infraLocation({ provider: 'openstack', credential: 'other' }, creds)).toBe('other');
    expect(infraLocation({ provider: 'openstack' }, creds)).toBeUndefined();
  });
});
