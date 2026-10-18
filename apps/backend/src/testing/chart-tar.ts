import { gzipSync } from 'node:zlib';

/** Minimal tar.gz writer for tests: one header block per entry. */
export function tar(
  entries: { name: string; content: string; type?: string; prefix?: string }[],
): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.content);
    const header = Buffer.alloc(512);
    header.write(e.name, 0, 100);
    header.write(data.length.toString(8).padStart(11, '0'), 124, 12);
    header.write(e.type ?? '0', 156, 1);
    header.write('ustar', 257);
    if (e.prefix) header.write(e.prefix, 345, 155);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
