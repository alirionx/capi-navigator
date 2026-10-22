/** One row of the cluster selector editor. */
export interface SelectorRow {
  key: string;
  value: string;
}

/** Rows of the form from a stored selector; one empty row to start with. */
export function selectorRows(labels: Record<string, string> | undefined): SelectorRow[] {
  const rows = Object.entries(labels ?? {}).map(([key, value]) => ({ key, value }));
  return rows.length ? rows : [{ key: '', value: 'true' }];
}

/** matchLabels from the rows; rows without a key are ignored. */
export function selectorLabels(rows: SelectorRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.filter((s) => s.key.trim()).map((s) => [s.key.trim(), s.value.trim()]),
  );
}
