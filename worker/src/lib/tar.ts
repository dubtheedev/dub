// A minimal ustar/GNU tar reader: enough for `evidence.tar` from `dub publish`.
// Regular files only; directories and other entry types are skipped.

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

export function* readTar(buf: Uint8Array): Generator<TarEntry> {
  let off = 0;
  let longName: string | null = null;
  const dec = new TextDecoder();
  const field = (start: number, len: number): string => {
    const slice = buf.subarray(off + start, off + start + len);
    const end = slice.indexOf(0);
    return dec.decode(end === -1 ? slice : slice.subarray(0, end));
  };
  while (off + 512 <= buf.length) {
    // Two zero blocks end the archive; one is tolerated as padding.
    if (isZero(buf, off, 512)) {
      off += 512;
      continue;
    }
    const name = field(0, 100);
    const sizeStr = field(124, 12).trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    if (Number.isNaN(size)) throw new Error(`tar: bad size at ${off}`);
    const type = field(156, 1) || '0';
    const magic = field(257, 6);
    let prefix = '';
    if (magic.startsWith('ustar')) prefix = field(345, 155);
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new Error('tar: truncated');
    const data = buf.subarray(dataStart, dataEnd);
    off = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      // GNU long name: the next entry's name.
      longName = dec.decode(data).replace(/\0+$/, '');
      continue;
    }
    if (type === '0' || type === '\0' || type === '') {
      const full = longName ?? (prefix ? `${prefix}/${name}` : name);
      longName = null;
      const clean = cleanPath(full);
      if (clean) yield { name: clean, data };
    } else {
      longName = null;
    }
  }
}

function isZero(buf: Uint8Array, off: number, len: number): boolean {
  for (let i = off; i < off + len && i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

/** Strips leading "./" and "/", refuses "..", returns null for unsafe names. */
export function cleanPath(p: string): string | null {
  const parts = p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) return null;
  return parts.join('/');
}
