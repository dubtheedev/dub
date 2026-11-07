// Builds a small ustar archive for tests.
export function ustar(entries: { name: string; data: Uint8Array; type?: string }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const e of entries) {
    const h = new Uint8Array(512);
    h.set(enc.encode(e.name).subarray(0, 100), 0);
    h.set(enc.encode('0000644\0'), 100);
    h.set(enc.encode('0000000\0'), 108);
    h.set(enc.encode('0000000\0'), 116);
    h.set(enc.encode(e.data.length.toString(8).padStart(11, '0') + '\0'), 124);
    h.set(enc.encode('00000000000\0'), 136);
    h.set(enc.encode('        '), 148);
    h.set(enc.encode(e.type ?? '0'), 156);
    h.set(enc.encode('ustar\0'), 257);
    h.set(enc.encode('00'), 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
    blocks.push(h);
    const padded = new Uint8Array(Math.ceil(e.data.length / 512) * 512);
    padded.set(e.data);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}
