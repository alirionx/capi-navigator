import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  extractTarget,
  KubeconfigError,
  listContexts,
  normalizedKubeconfig,
  pemToData,
} from './kubeconfig.js';

const kubeconfig = (user: string, cluster = 'certificate-authority-data: Q0E=') => `
apiVersion: v1
kind: Config
current-context: kind
clusters:
  - name: kind-cluster
    cluster:
      server: https://127.0.0.1:6443
      ${cluster}
  - name: other-cluster
    cluster:
      server: https://other.example:6443
users:
  - name: kind-user
    user:
      ${user}
  - name: other-user
    user:
      token: other-secret-token
contexts:
  - name: kind
    context: { cluster: kind-cluster, user: kind-user }
  - name: other
    context: { cluster: other-cluster, user: other-user }
`;

describe('kubeconfig handling (FP2-F-01)', () => {
  it('lists contexts without credentials', () => {
    const result = listContexts(kubeconfig('token: secret-token'));
    expect(result).toEqual({
      currentContext: 'kind',
      contexts: [
        { name: 'kind', cluster: 'kind-cluster', server: 'https://127.0.0.1:6443' },
        { name: 'other', cluster: 'other-cluster', server: 'https://other.example:6443' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('extracts the current context by default and a chosen context on request', () => {
    expect(extractTarget(kubeconfig('token: t1'))).toMatchObject({
      context: 'kind',
      server: 'https://127.0.0.1:6443',
      caData: 'Q0E=',
      token: 't1',
    });
    expect(extractTarget(kubeconfig('token: t1'), 'other')).toMatchObject({
      context: 'other',
      token: 'other-secret-token',
    });
  });

  it('accepts client certificates as embedded data', () => {
    const t = extractTarget(
      kubeconfig('client-certificate-data: Q0VSVA==\n      client-key-data: S0VZ'),
    );
    expect(t).toMatchObject({ certData: 'Q0VSVA==', keyData: 'S0VZ' });
  });

  it.each([
    ['exec: { command: aws, args: [eks, get-token] }', /exec plugin/],
    ['auth-provider: { name: oidc }', /auth-provider/],
    ['tokenFile: /var/run/token', /from a file/],
    ['client-certificate: /home/me/cert.pem\n      client-key-data: S0VZ', /from a file/],
  ])('rejects users that run commands or read files: %s', (user, message) => {
    expect(() => extractTarget(kubeconfig(user))).toThrow(message);
    try {
      extractTarget(kubeconfig(user));
    } catch (err) {
      expect((err as KubeconfigError).hint).toBeDefined();
    }
  });

  it('rejects CA certificates from files', () => {
    expect(() =>
      extractTarget(kubeconfig('token: t', 'certificate-authority: /etc/ca.crt')),
    ).toThrow(/from a file/);
  });

  it('reports broken input clearly', () => {
    expect(() => extractTarget('{ not: yaml: at all')).toThrow(KubeconfigError);
    expect(() => extractTarget('just a string')).toThrow(/not a YAML object/);
    expect(() => extractTarget(kubeconfig('token: t'), 'missing')).toThrow(
      /no context named "missing"/,
    );
    expect(() => extractTarget(kubeconfig('username: ""'))).toThrow(/no supported credentials/);
  });

  it('stores only the chosen context in normalized form', () => {
    const target = extractTarget(kubeconfig('token: t1'));
    const normalized = parse(normalizedKubeconfig('conn', target));
    expect(normalized).toEqual({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [
        {
          name: 'conn',
          cluster: { server: 'https://127.0.0.1:6443', 'certificate-authority-data': 'Q0E=' },
        },
      ],
      users: [{ name: 'conn', user: { token: 't1' } }],
      contexts: [{ name: 'conn', context: { cluster: 'conn', user: 'conn' } }],
      'current-context': 'conn',
    });
    expect(JSON.stringify(normalized)).not.toContain('other-secret-token');
  });

  it('encodes PEM certificates as kubeconfig data', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----';
    expect(Buffer.from(pemToData(pem), 'base64').toString()).toBe(`${pem}\n`);
  });
});
