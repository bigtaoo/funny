/**
 * assetsAreShipped.test.ts — every file under `client/src/assets/` must be something a player
 * actually downloads (ASSET_PACKAGING §13.5, §14).
 *
 * ## Why this exists
 *
 * `client/src/assets/` used to hold two different kinds of file that looked identical from the
 * outside: art that webpack emits because some module imports it, and `res_atlas.png` — a 904 KB
 * build-pipeline intermediate that nothing imported, existing only to be `patchMergedAtlas.js`'s
 * stamp source. A 2026-08-25 loading review saw the second kind, applied the obvious test ("no TS
 * import ⇒ dead weight"), and proposed deleting it. That would have broken the re-stamp pipeline
 * and four tests at once. The intermediate has since moved to `art/` (§2's "never packaged" L2
 * tier), which is what makes this assertion possible at all.
 *
 * The point is not to catch stray bytes — an unimported file does not ship, so it costs the player
 * nothing. The point is to keep **"nothing imports this" a trustworthy signal**. As long as that
 * holds, anyone can reason about this directory the obvious way. The moment one exception is
 * allowed back in, every future reader has to know the exception exists, and the trap resets.
 *
 * So a failure here is a design question, not a lint error, and there are exactly two right
 * answers: the file belongs under `art/` (it is a pipeline artifact), or something should import
 * it (it is real art that got orphaned by a refactor and is now silently missing from the game).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../src');
const ASSETS = path.join(SRC, 'assets');

/** Asset file types webpack turns into emitted URLs, plus the JSON that atlases import. */
const ASSET_EXT = /\.(png|jpe?g|gif|webp|mp3|wav|ogg|tao|json)$/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (ASSET_EXT.test(entry.name)) out.push(p);
  }
  return out;
}

function allSourceText(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) allSourceText(p, out);
    else if (entry.name.endsWith('.ts')) out.push(fs.readFileSync(p, 'utf8'));
  }
  return out;
}

/**
 * Resolved by convention rather than by a literal import, so a basename search cannot see them:
 * `webpack.config.js`'s `isMobile` branch swaps any `foo.png` for a sibling `foo.hires.png` at
 * module-resolve time (§9), which is the whole point — call sites never change. A `.hires` file
 * whose BASE file is missing would be a real orphan, so that case is checked separately below.
 */
const HIRES = /\.hires\.[^.]+$/;

describe('client/src/assets holds only shipped assets', () => {
  const files = walk(ASSETS);
  const sources = allSourceText(SRC).join('\n');

  it('finds assets to check at all (guards the walk itself)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(files.filter((f) => !HIRES.test(f)).map((f) => [path.relative(ASSETS, f).replace(/\\/g, '/'), f]))(
    '%s is imported by some module',
    (_rel, file) => {
      // Basename, not full path: imports are relative and spelled differently per importer depth.
      // Loose on purpose — this is a "did anyone reference it at all" check, and a false PASS here
      // only costs the byte-for-byte status quo, while a false FAIL would send someone deleting a
      // live asset.
      expect(sources).toContain(path.basename(file));
    },
  );

  // The other half of the .hires convention: the swap is silent, so a `foo.hires.png` whose `foo.png`
  // no longer exists means the mobile build resolves an asset that no other target has — or, worse,
  // that nothing resolves at all. Cheap to check, impossible to notice by reading.
  it.each(files.filter((f) => HIRES.test(f)).map((f) => [path.relative(ASSETS, f).replace(/\\/g, '/'), f]))(
    '%s has the base file its mobile-only swap replaces',
    (_rel, file) => {
      expect(fs.existsSync(file.replace('.hires', ''))).toBe(true);
    },
  );
});
