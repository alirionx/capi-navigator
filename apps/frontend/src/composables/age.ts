import { onBeforeUnmount, ref } from 'vue';

/** Age like kubectl: 45s, 12m, 5h, 3d (FP6-F-01). */
export function formatAge(iso: string | undefined, now: number): string {
  if (!iso) return '–';
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h < 10 && m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  return d < 10 && h > 0 ? `${d}d${h}h` : `${d}d`;
}

/** Full creation date for tooltips. */
export function formatCreated(iso: string | undefined): string {
  return iso
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(iso),
      )
    : '';
}

/** Current time, refreshed every 30 seconds, so ages stay current without reloading. */
export function useNow(intervalMs = 30_000) {
  const now = ref(Date.now());
  const timer = setInterval(() => (now.value = Date.now()), intervalMs);
  onBeforeUnmount(() => clearInterval(timer));
  return now;
}
