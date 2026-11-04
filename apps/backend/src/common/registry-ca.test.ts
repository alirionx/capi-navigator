import { describe, expect, it } from 'vitest';
import { TEST_CA, TEST_CA_WITHOUT_KEY_USAGE } from '../testing/test-cas.js';
import { registryCaProblems } from './registry-ca.js';

describe('registryCaProblems (FP29-F-10)', () => {
  it('accepts a CA with critical basic constraints and key usage', () => {
    expect(registryCaProblems(TEST_CA)).toEqual([]);
  });

  it('names what Python 3.13 rejects, per certificate of a bundle', () => {
    expect(registryCaProblems(`${TEST_CA}\n${TEST_CA_WITHOUT_KEY_USAGE}`)).toEqual([
      'CN=Test CA without key usage: basicConstraints is not marked critical.',
      'CN=Test CA without key usage: the keyUsage extension (keyCertSign, cRLSign) is missing.',
    ]);
  });

  it('reports unreadable certificates', () => {
    expect(
      registryCaProblems('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'),
    ).toEqual(['A certificate in the CA file cannot be read.']);
    expect(registryCaProblems('garbage')).toEqual([
      'The CA certificate contains no PEM certificate.',
    ]);
  });
});
