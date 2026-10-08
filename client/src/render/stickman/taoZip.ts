// ── .tao ZIP container access ─────────────────────────────────────────────────
// A `.tao` bundle is a plain ZIP holding animation.json, spritesheet.json and spritesheet.png
// (claudedocs/file-formats.md). This is the only place the client unzips anything.
//
// fflate instead of JSZip (2026-10-08, ASSET_PACKAGING §23): JSZip was ~95 KB of the minified
// entry bundle to read three entries out of a ZIP; fflate's `unzipSync` + `strFromU8` tree-shake to a
// few KB. What callers see is unchanged — test/taoZip.test.ts reads every shipped .tao with both
// libraries and asserts byte-identical results:
//   - text entries decode as UTF-8 (JSZip `async('string')`);
//   - the PNG is a Blob of the raw entry bytes with an empty MIME type, exactly what JSZip's
//     `async('blob')` produced (the browser sniffs the image type from the bytes either way);
//   - a buffer that is not a ZIP, or a missing entry, rejects (JSZip rejected / threw a TypeError on
//     the `!` dereference; this rejects with a message that names the entry).
// CRC32 is not verified, as before (JSZip's `checkCRC32` defaults to false).

import { unzipSync, strFromU8 } from 'fflate';

/** The three entries a `.tao` bundle is read for, decoded the way the loader consumes them. */
export interface TaoBundleEntries {
  animationJson: string;
  spritesheetJson: string;
  spritesheetPng: Blob;
}

const ENTRIES = ['animation.json', 'spritesheet.json', 'spritesheet.png'] as const;

/** Unzip a `.tao` bundle. Async so a parse failure surfaces as a rejection, like JSZip's loadAsync. */
export async function readTaoBundle(buf: ArrayBuffer): Promise<TaoBundleEntries> {
  // `filter` keeps fflate from inflating anything else a bundle may carry (editor leftovers).
  const files = unzipSync(new Uint8Array(buf), { filter: (f) => (ENTRIES as readonly string[]).includes(f.name) });
  const entry = (name: (typeof ENTRIES)[number]): Uint8Array => {
    const bytes = files[name];
    if (!bytes) throw new Error(`.tao bundle has no ${name}`);
    return bytes;
  };
  return {
    animationJson: strFromU8(entry('animation.json')),
    spritesheetJson: strFromU8(entry('spritesheet.json')),
    // fflate allocates its outputs with `new Uint8Array(n)`, i.e. on a plain ArrayBuffer; its typings
    // just say `Uint8Array` (ArrayBufferLike), which TS 5.9's BlobPart no longer accepts.
    spritesheetPng: new Blob([entry('spritesheet.png') as Uint8Array<ArrayBuffer>], { type: '' }),
  };
}
