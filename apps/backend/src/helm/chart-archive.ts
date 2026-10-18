import { gunzipSync } from 'node:zlib';

const MAX_UNPACKED = 64 * 1024 * 1024;

/**
 * Reads one file from a gzipped tar (a Helm chart archive), e.g. `podinfo/values.yaml`
 * (FP8-F-04). Understands ustar prefixes, PAX `path` records and GNU long names; returns
 * undefined if the file is missing. Nothing is written to disk.
 */
export function readFromChartArchive(
  tgz: Buffer,
  match: (path: string) => boolean,
): string | undefined {
  const tar = gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED });
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = field(header, 345, 155);
    const name =
      longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    const start = offset + 512;
    const data = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      longName = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(data.toString('utf8'))?.[1];
      continue;
    }
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if ((type === '0' || type === '\0') && match(name)) return data.toString('utf8');
  }
  return undefined;
}

function field(buf: Buffer, start: number, length: number): string {
  const raw = buf.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? length : end).toString('utf8');
}

/** `values.yaml` at the top level of the chart directory (not of subcharts). */
export function isTopLevelValues(path: string): boolean {
  return /^[^/]+\/values\.yaml$/.test(path);
}
