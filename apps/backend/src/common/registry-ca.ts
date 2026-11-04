import { X509Certificate } from 'node:crypto';

/** DER of the extension OIDs: key usage 2.5.29.15, basic constraints 2.5.29.19. */
const KEY_USAGE = Buffer.from('0603551d0f', 'hex');
const BASIC_CONSTRAINTS_CRITICAL = Buffer.from('0603551d130101ff', 'hex');

/**
 * FP29-F-10: what the nodes would reject in the CA certificate of an internal registry. The
 * artifact download runs in Python, which checks strictly since 3.13 (VERIFY_X509_STRICT, e.g.
 * Debian 13): a CA needs the key usage extension and critical basic constraints. Without them
 * every download fails and the machines never become ready, with nothing to see in the app.
 */
export function registryCaProblems(pem: string): string[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (!blocks.length) return ['The CA certificate contains no PEM certificate.'];
  const problems: string[] = [];
  for (const block of blocks) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(block);
    } catch {
      problems.push('A certificate in the CA file cannot be read.');
      continue;
    }
    const subject = cert.subject.replaceAll('\n', ', ');
    if (!cert.ca) {
      problems.push(`${subject} is no CA certificate (basicConstraints CA:TRUE is missing).`);
      continue;
    }
    if (!cert.raw.includes(BASIC_CONSTRAINTS_CRITICAL))
      problems.push(`${subject}: basicConstraints is not marked critical.`);
    if (!cert.raw.includes(KEY_USAGE))
      problems.push(`${subject}: the keyUsage extension (keyCertSign, cRLSign) is missing.`);
  }
  return problems;
}

export const REGISTRY_CA_HINT =
  'Python 3.13 and later on the nodes (e.g. Debian 13) reject such a CA when they download the Kubernetes binaries. Issue the CA with "basicConstraints=critical,CA:TRUE" and "keyUsage=critical,keyCertSign,cRLSign".';
