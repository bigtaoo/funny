/**
 * unitRigsAreBaked.test.ts — every `.tao` rig under `client/src/assets/units/` must be a BAKED
 * export, and must be the byte-for-byte copy of its `art/` master when one exists.
 *
 * ## Why this exists
 *
 * `max.tao` shipped 607 KB for two months where 14 KB would have rendered the same thing — 77% of
 * all unit-rig bytes in the client, for one of twelve units. The mechanism, reconstructed from the
 * blob sizes in git (2026-09-03):
 *
 *   06-25  art/units/max/max.tao and client/src/assets/max.tao are the same 621,970-byte file.
 *   06-27  the master is re-exported with export baking (ARCHITECTURE.md §8) down to 14,472 B.
 *          The copy under client/src/assets is not updated. This is the split.
 *   07-15  the head-behind-torso z-order fix. The master got it by re-export (head.zOrder 7 -> 11);
 *          the shipped copy got it by PATCHING THE OLD ARCHIVE IN PLACE — the whole commit moved
 *          that file by one byte.
 *   07-17  the shadow-frame eviction, again patched into the old archive (-68 B).
 *
 * So the shipped file stayed semantically correct the entire time — animations, attachmentPoints,
 * boneLengthScales, and every binding's anchorX/anchorY/zOrder/rotation/flipX are identical to the
 * master; only the bake differed. That is exactly why nobody noticed: there was nothing to see. And
 * `render/stickman/taoFormat.ts` is deliberately permissive about pre-bake bundles (its header says
 * so), so the loader had no reason to complain either. Two fixes were even hand-applied to the
 * stale copy without anyone asking why it was not simply re-copied.
 *
 * A failure here is a design question, not a lint error. The right answer is almost always
 * "re-export the rig from its `.taoeditor` project in tools/animator, or copy the master over" —
 * never "patch the shipped archive".
 *
 * ## What "baked" means, and why `unitHeight` is the marker
 *
 * The animator's export shrinks each bone image to its real displayed resolution (times a
 * supersample margin) and rewrites `binding.scaleX/Y` to compensate, so `frame.w * binding.scaleX`
 * is preserved and the runtime needs no change (ARCHITECTURE.md §8). Two consequences are exact,
 * with no thresholds to tune:
 *
 *   - the exporter records what it baked against in `animation.json.unitHeight`
 *     (`{ tier, targetScreenPx, naturalHeight, supersample }`), so a bundle without it predates
 *     baking;
 *   - baking only ever SHRINKS the image, so the compensating scale is always > 1. A pre-bake
 *     export carries the art's own down-scale instead: max's was 0.667, against 3.1–6.3 for the
 *     seventeen baked rigs.
 *
 * Deliberately NOT asserted: a bound on frame dimensions. `skin_archer`'s tallest frame is already
 * 173px against a 108px (54 * 2) bake target, because the bake is per-bone and a long limb legitimately
 * exceeds the whole unit's height. Any bound loose enough for that is a magic number; `unitHeight`
 * is a fact.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import JSZip from 'jszip';

const CLIENT = path.resolve(__dirname, '..');
const REPO = path.resolve(CLIENT, '..');
const SHIPPED_DIRS = [
  path.join(CLIENT, 'src/assets/units'),
  path.join(CLIENT, 'src/assets/units/skins'),
];

/**
 * Per-rig ceiling. The largest baked rig in the repo is `skin_archer` at 40 KB, then `harpy` at
 * 25 KB; a pre-bake export of this art lands around 600 KB, so anything in between is unambiguous.
 * 64 KB leaves headroom for a genuinely bigger character without leaving room for an un-baked one.
 * Raising this is fine — but only after checking the rig is baked, because that is the failure this
 * number is shaped to catch if a future exporter ever stops writing `unitHeight`.
 */
const MAX_RIG_BYTES = 64 * 1024;

type Binding = { scaleX: number; scaleY: number };
type AnimationJson = {
  version: number;
  bindings: Record<string, Binding>;
  unitHeight?: { tier: string; targetScreenPx: number; naturalHeight: number; supersample: number };
};

function shippedRigs(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const dir of SHIPPED_DIRS) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.tao')) out.push([name.slice(0, -4), path.join(dir, name)]);
    }
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

/** Read `animation.json` out of a .tao the way the runtime does — same ZIP library the client ships. */
async function animationJson(file: string): Promise<AnimationJson> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const entry = zip.file('animation.json');
  expect(entry, `${path.basename(file)} has no animation.json`).toBeTruthy();
  return JSON.parse(await entry!.async('string')) as AnimationJson;
}

/**
 * The `art/` master for a shipped rig, or null when the rig has no master under version control.
 * Today that is the 6 skins (only their `.taoeditor` projects are kept) and `medic` (whose only
 * `.tao` in `art/` is the deliberately archived old rig under `art/units/old/`, which is a
 * different file by intent — see CHARACTER_DESIGN.md §7.5). `art/units/old/**` is excluded for
 * exactly that reason: matching it would assert the opposite of what those files are for.
 */
function masterFor(rig: string): string | null {
  const candidates = [
    path.join(REPO, 'art/units', rig, `${rig}.tao`),
    path.join(REPO, 'art/skins', rig.replace(/^skin_/, ''), `${rig}.tao`),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const RIGS = shippedRigs();
const md5 = (p: string): string => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

describe('shipped unit rigs are baked exports', () => {
  it('finds the rigs at all (guards the directory walk itself)', () => {
    expect(RIGS.map(([name]) => name)).toContain('max');
    expect(RIGS.length).toBeGreaterThanOrEqual(18);
  });

  it.each(RIGS)('%s carries the exporter\'s unitHeight bake record', async (_name, file) => {
    const anim = await animationJson(file);
    // A bundle without this predates export baking — see the header.
    expect(anim.unitHeight).toBeTruthy();
    expect(anim.unitHeight!.targetScreenPx).toBeGreaterThan(0);
    expect(anim.unitHeight!.supersample).toBeGreaterThan(0);
  });

  it.each(RIGS)('%s compensates every binding with a scale > 1 (baking only shrinks)', async (_name, file) => {
    const anim = await animationJson(file);
    const bones = Object.keys(anim.bindings);
    expect(bones.length).toBeGreaterThan(0);
    for (const bone of bones) {
      expect(anim.bindings[bone]!.scaleX, `${path.basename(file)} ${bone}.scaleX`).toBeGreaterThan(1);
      expect(anim.bindings[bone]!.scaleY, `${path.basename(file)} ${bone}.scaleY`).toBeGreaterThan(1);
    }
  });

  it.each(RIGS)('%s stays under the per-rig byte ceiling', (_name, file) => {
    expect(fs.statSync(file).size).toBeLessThanOrEqual(MAX_RIG_BYTES);
  });
});

describe('shipped unit rigs are copies of their art/ masters', () => {
  const paired = RIGS.map(([name, file]) => [name, file, masterFor(name)] as const)
    .filter((row): row is readonly [string, string, string] => row[2] !== null);

  it('finds masters to compare against (guards masterFor itself)', () => {
    // 11 of the 12 shipped units have a master; medic and the 6 skins do not — see masterFor's doc
    // comment. If this list moves, a master was added or deleted, and that is worth a deliberate look.
    expect(paired.map(([name]) => name)).toEqual([
      'archer', 'berserker', 'harpy', 'infantry', 'ironclad', 'lena',
      'mara', 'max', 'runner', 'shieldbearer', 'splitter',
    ]);
  });

  it.each(paired)('%s is byte-identical to its master', (_name, shipped, master) => {
    // Not "equivalent" — identical. The moment these are allowed to drift, the shipped copy stops
    // being reproducible from the .taoeditor project, and fixes start getting hand-patched into it.
    expect(md5(shipped)).toBe(md5(master));
  });
});
