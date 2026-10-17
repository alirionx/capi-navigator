import { CoordinationV1Api, V1MicroTime, type V1Lease } from '@kubernetes/client-node';
import { isConflict, isNotFound } from './errors.js';

/**
 * Takes or renews a Lease, so that only one backend replica runs a background job at a time
 * (STATE-04). Returns false while another live holder owns it.
 */
export async function acquireLease(
  leases: CoordinationV1Api,
  opts: { namespace: string; name: string; holder: string; durationSeconds: number },
  now = new Date(),
): Promise<boolean> {
  const { namespace, name, holder, durationSeconds } = opts;
  const spec = {
    holderIdentity: holder,
    leaseDurationSeconds: durationSeconds,
    renewTime: new V1MicroTime(now.getTime()),
  };
  let lease: V1Lease;
  try {
    lease = await leases.readNamespacedLease({ name, namespace });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    try {
      await leases.createNamespacedLease({
        namespace,
        body: { metadata: { name, namespace }, spec },
      });
      return true;
    } catch (createErr) {
      if (isConflict(createErr)) return false;
      throw createErr;
    }
  }
  const current = lease.spec?.holderIdentity;
  const renew = lease.spec?.renewTime ? new Date(lease.spec.renewTime).getTime() : 0;
  const duration = (lease.spec?.leaseDurationSeconds ?? durationSeconds) * 1000;
  if (current && current !== holder && renew + duration > now.getTime()) return false;
  try {
    await leases.replaceNamespacedLease({
      name,
      namespace,
      body: { ...lease, spec: { ...lease.spec, ...spec } },
    });
    return true;
  } catch (err) {
    if (isConflict(err)) return false;
    throw err;
  }
}
