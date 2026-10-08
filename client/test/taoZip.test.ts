/**
 * taoZip.test.ts — the fflate-based `.tao` unzip (src/render/stickman/taoZip.ts) must hand
 * `assetLoader.parseTaoAsset` exactly what the JSZip calls it replaced did (ASSET_PACKAGING §23).
 *
 * JSZip stays a devDependency for this one reason: it is the reference implementation. Every
 * shipped `.tao` is read both ways and compared byte for byte — the two JSON entries as decoded
 * strings (`async('string')`), the spritesheet as Blob bytes AND Blob type (`async('blob')`, which
 * JSZip creates with an empty MIME type). The failure paths are pinned too: not-a-ZIP and a
 * missing entry both have to reject, because `parseTaoAsset`'s callers (StickmanRuntime.loadAsset)
 * turn a rejection into the circle-placeholder fallback.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { readTaoBundle } from '../src/render/stickman/taoZip';

const ASSETS = path.resolve(__dirname, '../src/assets');

function taoFiles(dir = ASSETS, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) taoFiles(p, out);
    else if (e.name.endsWith('.tao')) out.push(p);
  }
  return out;
}

function arrayBufferOf(file: string): ArrayBuffer {
  const b = fs.readFileSync(file);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

const FILES = taoFiles();

describe('readTaoBundle (fflate) matches JSZip on every shipped .tao', () => {
  it('finds the shipped bundles (guards the walk itself)', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(18);
  });

  it.each(FILES.map((f) => [path.relative(ASSETS, f).replace(/\\/g, '/'), f]))('%s', async (_rel, file) => {
    const ours = await readTaoBundle(arrayBufferOf(file));
    const zip = await JSZip.loadAsync(arrayBufferOf(file));

    expect(ours.animationJson).toBe(await zip.file('animation.json')!.async('string'));
    expect(ours.spritesheetJson).toBe(await zip.file('spritesheet.json')!.async('string'));

    const refBlob = await zip.file('spritesheet.png')!.async('blob');
    expect(ours.spritesheetPng.type).toBe(refBlob.type);
    const a = new Uint8Array(await ours.spritesheetPng.arrayBuffer());
    const b = new Uint8Array(await refBlob.arrayBuffer());
    expect(a.length).toBe(b.length);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    // A real PNG, not an empty/garbled inflate that both libraries could agree on.
    expect(Array.from(a.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe('readTaoBundle failure paths reject like the JSZip path did', () => {
  it('rejects a buffer that is not a ZIP', async () => {
    const png1x1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await expect(readTaoBundle(png1x1.buffer)).rejects.toThrow();
    await expect(JSZip.loadAsync(png1x1.buffer)).rejects.toThrow();
  });

  it('rejects a ZIP that lacks one of the three entries, naming it', async () => {
    const zip = new JSZip();
    zip.file('animation.json', '{}');
    zip.file('spritesheet.png', new Uint8Array([1, 2, 3]));
    const buf = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
    await expect(readTaoBundle(buf)).rejects.toThrow('spritesheet.json');
  });

  it('decodes stored and deflated entries alike, including non-ASCII UTF-8', async () => {
    for (const compression of ['STORE', 'DEFLATE'] as const) {
      const zip = new JSZip();
      const anim = JSON.stringify({ name: '笔记本 — ünïcode ✓' });
      zip.file('animation.json', anim);
      zip.file('spritesheet.json', '{"frames":{}}');
      zip.file('spritesheet.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      zip.file('editor-leftover.bin', new Uint8Array(1024));
      const buf = await zip.generateAsync({ type: 'arraybuffer', compression });
      const ours = await readTaoBundle(buf);
      expect(ours.animationJson).toBe(anim);
      expect(ours.spritesheetJson).toBe('{"frames":{}}');
      expect(Array.from(new Uint8Array(await ours.spritesheetPng.arrayBuffer()))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
  });
});
