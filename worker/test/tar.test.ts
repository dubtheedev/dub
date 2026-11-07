import { describe, expect, it } from 'vitest';
import { cleanPath, readTar } from '../src/lib/tar';
import { ustar } from './tar-build';

describe('readTar', () => {
  it('reads regular files, skips directories, strips ./', () => {
    const enc = new TextEncoder();
    const tar = ustar([
      { name: './ac-1/', data: new Uint8Array(0), type: '5' },
      { name: './ac-1/list.png', data: enc.encode('PNG') },
      { name: 'ac-3/flow.webm', data: new Uint8Array(600).fill(7) },
    ]);
    const entries = [...readTar(tar)];
    expect(entries.map((e) => e.name)).toEqual(['ac-1/list.png', 'ac-3/flow.webm']);
    expect(new TextDecoder().decode(entries[0]!.data)).toBe('PNG');
    expect(entries[1]!.data.length).toBe(600);
  });
  it('handles GNU long names', () => {
    const long = 'ac-2/' + 'x'.repeat(120) + '.png';
    const enc = new TextEncoder();
    const tar = ustar([
      { name: '././@LongLink', data: enc.encode(long + '\0'), type: 'L' },
      { name: long.slice(0, 99), data: enc.encode('data') },
    ]);
    expect([...readTar(tar)].map((e) => e.name)).toEqual([long]);
  });
  it('refuses path traversal', () => {
    expect(cleanPath('../x')).toBeNull();
    expect(cleanPath('/abs/x')).toBe('abs/x');
    expect(cleanPath('./a/./b')).toBe('a/b');
  });
});
