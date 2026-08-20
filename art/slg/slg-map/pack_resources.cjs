/**
 * pack_resources.cjs — Process res_*.{webp,png} SLG map resource motifs and pack them into a PixiJS-ready atlas.
 *
 * 5 stationery motifs (one per SLG season resource): res_ink / res_paper / res_graphite / res_metal / res_sticker,
 * plus per-level bespoke frames `res_<type>_l<n>` dropped in as white-bg source files. Every frame here is a real
 * hand-drawn image loaded from disk — NOTHING is composited/baked at build time anymore (the old l1–5 dice-pip
 * count-trays + synthetic heaps were replaced by bespoke l1–5 art on 2026-07-17, see slg-resource-art.md §5).
 * Coverage: paper/ink/graphite/metal l1–l10 bespoke; sticker l6–l10 bespoke (no l1–5, only spawns on lvl≥6).
 *
 * Processing pipeline (all in memory, no intermediate files):
 *   1. Load image → remove white background: alpha = 255 - luminance (white bg → transparent, ink lines → opaque,
 *      anti-aliased grey edges → semi-transparent), original line color preserved.
 *   2. Crop surrounding whitespace using the content bounding box.
 *   3. Scale proportionally so the long edge = LONG_EDGE (128px; map icons are viewed closely + clustered).
 *   4. Shelf-pack into a single atlas PNG (PAD spacing to prevent bleeding).
 *   5. Export res_atlas.png + res_atlas.json (TexturePacker JSON-Hash, parsed directly by PIXI.Spritesheet).
 *   6. Copy both into client/src/assets/slg/ for the game to consume.
 *
 * Usage:    node pack_resources.cjs
 * Requires: reuses client/node_modules/sharp (no separate install needed).
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.resolve(__dirname, '../../../client/node_modules/sharp'));

const LONG_EDGE = 128;  // map-resource motif target long edge (closely viewed + clustered → C-group resolution)
const PAD = 2;          // per-frame spacing inside the atlas
const ATLAS_W = 512;    // atlas width (fixed)
const ALPHA_TRIM = 16;  // alpha threshold for considering a pixel "has content" during crop

// ── Level-read contract (design/product/slg-resource-art.md §6, 2026-08-19) ────────────────────
// The level read is SOLVED HERE and baked into the atlas as per-frame `nw.sizeMul` / `nw.alphaMul`,
// so both renderers (client drawResMotif + map-editor's copy) carry zero level->size/alpha logic.
// Why it moved here: the packer is the only place that can measure how much ink a frame actually
// contains, and the read depends on that measurement — see the failure it replaces below.
//
// Old contract (retired): "render width-normalised, so taller-drawn art reads as a higher tier."
// It punished sideways growth. High tiers express abundance by spreading sideways, width
// normalisation then shrank the whole drawing, so the more the artist drew the smaller it landed —
// measured ink mass per tile dropped at l5->l6 for all four base resources, and ink l4 rendered as
// the heaviest frame of all ten levels (the tile the player circled on the map).
//
// New contract:
//   footprint = BASE * LEVEL_SCALE(lv), normalised on the frame's EQUIVALENT EDGE sqrt(w*h) — a wide
//              cluster and a tall bottle occupy the same visual area, so composition is free again.
//   rendered ink mass R(lv) = density * LEVEL_SCALE(lv)^2 * alpha  must rise monotonically with a
//              real per-step margin (INK_GROWTH), because that margin IS the level read.
// alpha can only DIM an over-full frame (alpha <= 1), never darken an under-drawn one, so a frame
// drawn sparser than its tier is an art-side defect no code can fix. ALPHA_FLOOR turns that into a
// build failure instead of a silently unreadable map.
const LEVEL_SCALE_LO = 0.80;   // footprint multiplier at l1
const LEVEL_SCALE_HI = 1.30;   // ...and at l10 (0.30 tile-pitch * 1.30 = 0.39 tp, inside the 0.40 that read as a carpet)
// The rule is NO INVERSION, not a per-step margin. Requiring rendered ink to climb every level is
// unsatisfiable, and the measurement says so plainly: ink l4 is ONE bottle of ink at density 0.390,
// ink l9 is SEVEN bottles at 0.376. Under equal-area normalisation a single large solid object
// out-inks a crowd of small ones with white glass between them, so "more objects" and "more ink" pull
// against each other — no drawing can satisfy both, and two rounds of prompting proved it by
// overshooting 3-4x sparse then 3-4x dense. What the player actually needs is narrower: a higher tier
// must never read as LESS than a lower one. Separation between adjacent tiers is carried by the
// footprint curve (monotone by construction, art cannot break it), by object count, and by the Lv.N
// label from l6 up — not by ink mass. So the gate guards against reading backwards, and nothing more.
const INK_TOLERANCE = 0.10;    // how far below the heaviest lower tier a frame may sit before it reads backwards
// alpha is a TRIM, not a channel. Everything on this map is drawn with one pen, and a frame rendered
// at 0.4 next to a frame rendered at 1.0 reads as a different pen, not as less resource — so alpha may
// only shave the small mismatches (a 15% dim on a black line at tile size is below notice). Letting it
// range freely "solves" any curve on paper while wrecking the drawing: the first version of this gate
// passed the current art by dimming ink l4 to 0.37 while ink l9 sat at 1.00, which is exactly the
// washed-out-next-to-solid look the contract exists to prevent. The level read therefore rides on
// footprint (LEVEL_SCALE) plus how full the artwork itself is drawn — and that makes an under-drawn
// high tier an art defect the build must reject rather than silently absorb.
const ALPHA_MIN = 0.85;
const GATE_EPS = 1.02;         // a frame landing within 2% of the required ink is at the band's edge, not a defect
const levelScale = (lv) => LEVEL_SCALE_LO + (LEVEL_SCALE_HI - LEVEL_SCALE_LO) * (lv - 1) / 9;
const OUT_DIRS = [
  path.resolve(__dirname, '../../../client/src/assets/slg'),
  path.resolve(__dirname, '../../../tools/map-editor/src/assets/slg'),  // §5.8: keep both byte-identical
];

const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

// Escape hatch for the transition only: report the §6 violations but still emit the atlas, so the
// renderer work is not blocked on all 20 replacement drawings landing first. CI runs without it.
const REPORT_ONLY = process.argv.includes('--report-only');

// ── Per-level tier colour band (sticker only) ──────────────────────────────────
// Level legibility (l1→l10, taller/fuller/more-scatter) is now carried entirely by the bespoke art's
// own silhouette — the map renderer draws each level frame width-normalised (on-screen width = const,
// height follows the frame's aspect ratio, see client/src/render/tileGraphics.ts drawResMotif), so a
// taller-drawn frame reads as a higher tier with zero renderer change.
// The colour band below survives ONLY for sticker (铜钱): its l6→l10 tan→gold ramp reads as "copper
// coin → gold", a thematic bonus. paper/ink/graphite/metal keep their original black ink at every
// level (read by silhouette, consistent l1–l10) — see tintLevelFrame's exemption.
// Desaturated tier bands, paper-cohesive (low = cool slate → mid = tan → high = amber → l10 = gold).
// Applied as a partial multiply so the pencil linework survives. [r,g,b] per level, index = level.
const BAND = [
  null,
  [0x9f, 0xb2, 0xc6], [0x9f, 0xb2, 0xc6], // l1–2 cool slate-blue
  [0xa6, 0xb8, 0x8c], [0xa6, 0xb8, 0x8c], // l3–4 sage
  [0xd6, 0xc2, 0x8a], [0xd6, 0xc2, 0x8a], // l5–6 warm tan
  [0xd8, 0x9f, 0x60], [0xd8, 0x9f, 0x60], // l7–8 amber
  [0xcf, 0x78, 0x4d],                     // l9   rust
  [0xe6, 0xb4, 0x22],                     // l10  gold
];
const BAND_STRENGTH = 0.72;

/** Partial-multiply tier tint over the opaque pixels of a raw RGBA buffer (in place). */
function applyBand(buf, w, h, lv) {
  const c = BAND[lv];
  if (!c) return;
  const s = BAND_STRENGTH;
  for (let i = 0; i < w * h; i++) {
    if (buf[i * 4 + 3] === 0) continue;
    for (let k = 0; k < 3; k++) {
      const src = buf[i * 4 + k];
      buf[i * 4 + k] = Math.round(src * (1 - s) + (src * c[k] / 255) * s);
    }
  }
}

/** Decode a packed level frame's PNG buffer, apply its tier band, re-encode. Returns a new sprite. */
async function tintLevelFrame(sprite) {
  const m = /_l(\d+)$/.exec(sprite.name);
  if (!m) return sprite;
  const lv = Number(m[1]);
  // paper/ink/graphite/metal are bespoke hand-drawn art at EVERY level (l1–l10) — keep their original
  // black ink so the whole ramp reads by silhouette and stays consistent (2026-07-17: exemption widened
  // from l6+ to all levels when l1–5 became bespoke too). Only sticker keeps the band (its tan→gold ramp
  // reads as copper→gold, a thematic cue for the currency resource).
  if (/^res_(paper|ink|graphite|metal)_/.test(sprite.name)) return sprite;
  const { data, info } = await sharp(sprite.buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  applyBand(data, info.width, info.height, lv);
  const buf = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return { ...sprite, buf };
}

/**
 * Solve the level read for one resource type and name whichever frames read backwards.
 *
 * `reach` is the rendered ink a frame lands at full pen: density * LEVEL_SCALE(lv)^2. Walking up from
 * l1, each level must stay within INK_TOLERANCE of the heaviest tier BELOW it — never climb past it,
 * just never fall visibly under it. Each frame is held as light as that rule allows (alpha may shave
 * up to 1-ALPHA_MIN) so one over-inked drawing does not raise the bar for everything above it.
 *
 * Blame is reported against the specific lower frame doing the blocking, because that frame is as
 * often the real defect as the one that trips the check — a near-black mid tier is exactly how batch
 * two failed.
 */
function solveLevelRead(levels) {
  const reach = new Map(levels.map((f) => [f.lv, f.density * levelScale(f.lv) ** 2]));
  const R = new Map();
  const offenders = [];
  let peak = 0, peakLv = null;
  for (const f of levels) {
    const bound = peak * (1 - INK_TOLERANCE);
    const want = Math.max(ALPHA_MIN * reach.get(f.lv), bound);
    if (want > reach.get(f.lv) * GATE_EPS) {
      offenders.push({
        lv: f.lv, blocker: peakLv, density: f.density,
        can: reach.get(f.lv), need: bound, drop: 1 - reach.get(f.lv) / peak,
        target: bound / levelScale(f.lv) ** 2,
      });
    }
    const got = Math.min(reach.get(f.lv), want);
    R.set(f.lv, got);
    if (got > peak) { peak = got; peakLv = f.lv; }
  }
  const solved = new Map();
  for (const f of levels) {
    const alpha = Math.min(1, Math.max(ALPHA_MIN, R.get(f.lv) / reach.get(f.lv)));
    solved.set(f.lv, { sizeMul: levelScale(f.lv) / f.equivEdge, alphaMul: alpha });
  }
  return { solved, offenders, reach };
}

/**
 * Blank out a drawn rectangular border, if the generation put one in.
 *
 * A frame around the drawing is fatal in a way that is easy to miss: the crop below takes the content
 * bounding box, so the border BECOMES the bounding box — the tile then shows a rectangle with the
 * subject shrunk inside it, and the frame's own ink is counted as resource. Caught on res_paper_l6 in
 * the 2026-08-19 batch, where an edge-band check missed it entirely because the ring sat 13px in from
 * the edge rather than on it.
 *
 * Detection is a ring scan: a real border darkens ALL FOUR sides at the SAME inset, which none of the
 * five stationery subjects ever does. Everything from the image edge through the ring is cleared, and
 * the strip is logged — quietly cropping someone's artwork is not something to do silently, but
 * neither is eyeballing every generation by hand forever.
 */
function stripBorderRing(data, W, H, ch, name) {
  const dark = (x, y) => {
    const i = (y * W + x) * ch;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 200;
  };
  const sides = (ins) => {
    let t = 0, b = 0, l = 0, r = 0;
    for (let x = ins; x < W - ins; x++) { if (dark(x, ins)) t++; if (dark(x, H - 1 - ins)) b++; }
    for (let y = ins; y < H - ins; y++) { if (dark(ins, y)) l++; if (dark(W - 1 - ins, y)) r++; }
    const nx = W - 2 * ins, ny = H - 2 * ins;
    return Math.min(t / nx, b / nx, l / ny, r / ny);
  };
  const limit = Math.floor(Math.min(W, H) * 0.05);
  let hit = -1;
  for (let ins = 0; ins < limit; ins++) if (sides(ins) > 0.75) { hit = ins; break; }
  if (hit < 0) return 0;
  let outer = hit;
  while (outer + 1 < limit && sides(outer + 1) > 0.25) outer++;
  const cut = outer + 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (Math.min(x, y, W - 1 - x, H - 1 - y) > cut) continue;
      const i = (y * W + x) * ch;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      if (ch === 4) data[i + 3] = 0;
    }
  }
  console.log(`  ⚠ ${name}: stripped a drawn border ring (inset ${hit}–${outer}px) before cropping`);
  return cut;
}

async function processImage(file, longEdge) {
  const name = path.basename(file).replace(/\.(webp|png)$/i, '');
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: ch } = info;

  stripBorderRing(data, W, H, ch, name);

  // Remove white background + compute content bounding box
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let a = Math.round(255 - lum);
      if (a < 0) a = 0; else if (a > 255) a = 255;
      // If the source already has an alpha channel, take the smaller value (preserve original transparency)
      if (ch === 4) a = Math.min(a, data[i + 3]);
      data[i + 3] = a;
      if (a > ALPHA_TRIM) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error(`${name}: empty image (no content)`);

  const cropW = maxX - minX + 1, cropH = maxY - minY + 1;
  const cropBuf = Buffer.alloc(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const si = ((y + minY) * W + (x + minX)) * ch;
      const di = (y * cropW + x) * 4;
      // Neutralise the pen. §5.3 #1 asks for single-colour ink, and the map mixes frames drawn months
      // apart — whatever hue a generation run happened to favour has to be normalised away here or the
      // tiles read as different pens. Measured on the 2026-08-19 batch: the new drawings carried a blue
      // cast of b-r +6..+51 while every frame they sit beside was neutral (+0..+7), plainly visible as
      // navy tiles among black ones. Collapsing RGB to luma keeps stroke darkness (and therefore the
      // measured density the level read depends on) while making hue drift structurally impossible.
      // Sticker's tier band is applied afterwards, so it still gets its copper->gold ramp on top.
      const lum = Math.round(0.299 * data[si] + 0.587 * data[si + 1] + 0.114 * data[si + 2]);
      cropBuf[di] = lum; cropBuf[di + 1] = lum; cropBuf[di + 2] = lum;
      cropBuf[di + 3] = data[si + 3];
    }
  }

  // Proportional scale: long edge = longEdge. This is a STORAGE resolution only — it no longer
  // carries any tier meaning (see the level-read contract above); the renderer normalises on
  // sqrt(w*h) instead, so which edge we pin here is irrelevant to how the frame reads on a tile.
  const scale = longEdge / Math.max(cropW, cropH);
  const newW = Math.max(1, Math.round(cropW * scale));
  const newH = Math.max(1, Math.round(cropH * scale));
  const resized = await sharp(cropBuf, { raw: { width: cropW, height: cropH, channels: 4 } })
    .resize(newW, newH, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });

  // Ink mass = integral of alpha over the frame, measured on the STORED pixels (what actually gets
  // scaled onto a tile). `density` divides it out by frame area, so it is independent of how big the
  // frame happens to be drawn — it is purely "how full / how black is this drawing", which is the
  // only property of the artwork the level read still depends on.
  let mass = 0;
  for (let i = 3; i < resized.data.length; i += 4) mass += resized.data[i];
  mass /= 255;

  const buf = await sharp(resized.data, { raw: { width: newW, height: newH, channels: 4 } }).png().toBuffer();
  return { name, buf, w: newW, h: newH, inkMass: mass, density: mass / (newW * newH) };
}

const loadSprite = (file) => processImage(file, LONG_EDGE);

async function main() {
  // `res_contact_sheet.png` is this pipeline's own OUTPUT (art/scripts/resContactSheet.js writes it
  // here, slg-resource-art.md §6.11) and it matches the source pattern, so the second run after a
  // sheet exists silently packs the sheet as a 51st frame — 5 KB of atlas spent on a picture of the
  // atlas, and the frame count check stops meaning anything. Exclude it by name rather than renaming
  // the sheet: the sheet's path is referenced from the doc and from the verification habit.
  const files = fs.readdirSync(__dirname)
    .filter((f) => /^res_.*\.(webp|png)$/i.test(f) && f !== 'res_contact_sheet.png')
    .sort();
  if (!files.length) { console.error('No res_*.{webp,png} files found'); process.exit(1); }

  const sprites = [];
  for (const f of files) sprites.push(await loadSprite(path.join(__dirname, f)));

  // Tier colour band — sticker only (paper/ink/graphite/metal are exempt at every level, see tintLevelFrame).
  // Runs before the level-read solve: the band multiplies RGB only, never alpha, so measured density
  // (and therefore the solved curve) is unaffected by it.
  for (let i = 0; i < sprites.length; i++) sprites[i] = await tintLevelFrame(sprites[i]);

  // ── Solve + gate the level read, per resource type (§6.3) ───────────────────────────────────
  const byType = new Map();
  for (const s of sprites) {
    const m = /^res_([a-z]+)_l(\d+)$/.exec(s.name);
    if (!m) continue;  // the 5 generic motif frames carry no tier
    if (!byType.has(m[1])) byType.set(m[1], []);
    byType.get(m[1]).push({ lv: Number(m[2]), density: s.density, equivEdge: Math.sqrt(s.w * s.h), name: s.name });
  }
  const solvedByName = new Map();
  const failures = [];
  for (const [type, levels] of [...byType].sort()) {
    levels.sort((a, b) => a.lv - b.lv);
    const { solved, offenders, reach } = solveLevelRead(levels);
    for (const f of levels) solvedByName.set(f.name, solved.get(f.lv));
    console.log(`
  ${type}:`);
    console.table(levels.map((f) => ({
      level: `l${f.lv}`,
      density: f.density.toFixed(3),
      reach: reach.get(f.lv).toFixed(3),
      sizeMul: solved.get(f.lv).sizeMul.toFixed(4),
      alpha: solved.get(f.lv).alphaMul.toFixed(2),
      verdict: offenders.some((o) => o.lv === f.lv) ? 'READS BACKWARDS' : '',
    })));
    for (const o of offenders) {
      failures.push(`res_${type}_l${o.lv} reads BACKWARDS: ${(o.drop * 100).toFixed(0)}% lighter than l${o.blocker} below it (${o.can.toFixed(3)} vs ${(o.need / (1 - INK_TOLERANCE)).toFixed(3)} rendered ink) → redraw l${o.lv} at density ≈${o.target.toFixed(2)} (now ${o.density.toFixed(3)}), or lighten l${o.blocker}`);
    }
  }
  if (failures.length) {
    console.error(`
❌ level read unreadable — ${failures.length} frame(s) violate the §6 contract:`);
    for (const f of failures) console.error(`   ${f}`);
    if (!REPORT_ONLY) {
      console.error(`
   Redraw them (prompts: design/product/slg-resource-art.md §6.5), or re-run with`);
      console.error(`   --report-only to pack anyway while the new art is still being produced.`);
      process.exit(1);
    }
    console.error(`
   --report-only given: packing anyway. The map will read wrong until these land.`);
  } else {
    console.log(`
✅ level read clears the §6 contract (no tier reads lighter than one below it, pen held within ${ALPHA_MIN}–1.00).`);
  }

  // Shelf packing: sort by height descending, fill row by row
  sprites.sort((a, b) => b.h - a.h);
  let cx = PAD, cy = PAD, rowH = 0, usedH = 0;
  for (const s of sprites) {
    if (cx + s.w + PAD > ATLAS_W) { cx = PAD; cy += rowH + PAD; rowH = 0; }
    s.x = cx; s.y = cy;
    cx += s.w + PAD;
    if (s.h > rowH) rowH = s.h;
    usedH = cy + rowH + PAD;
  }
  const ATLAS_H = nextPow2(usedH);

  // Composite atlas (compressed PNG: palette + max effort)
  const composites = sprites.map((s) => ({ input: s.buf, left: s.x, top: s.y }));
  const atlasBuf = await sharp({ create: { width: ATLAS_W, height: ATLAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites).png({ palette: true, compressionLevel: 9, effort: 10 }).toBuffer();

  // Export JSON (TexturePacker JSON-Hash) — frame names have no extension, for use as textures['res_ink']
  const frames = {};
  for (const s of [...sprites].sort((a, b) => a.name.localeCompare(b.name))) {
    // `nw` is our own extension: the solved level read, per frame. PIXI's Spritesheet parser reads
    // only the known keys and ignores this one, and mergeAtlasPages.js copies frame entries with
    // `{...f}`, so it survives the merge into world_atlas.json — which is the atlas the client
    // actually loads. (Putting it under `meta` instead would be silently dropped: the merger keeps
    // only `data.frames` and writes its own `meta`.)
    const solved = solvedByName.get(s.name);
    frames[s.name] = {
      frame: { x: s.x, y: s.y, w: s.w, h: s.h },
      rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: s.w, h: s.h },
      sourceSize: { w: s.w, h: s.h },
      nw: {
        inkMass: Math.round(s.inkMass),
        density: Number(s.density.toFixed(5)),
        equivEdge: Number(Math.sqrt(s.w * s.h).toFixed(2)),
        // Renderer contract: on-screen scale = tilePitch * MOTIF_SIZE_FRAC * sizeMul, alpha = alphaMul.
        // Generic motif frames have no tier, so they sit at the curve's midpoint (levelScale = 1.0).
        sizeMul: Number((solved ? solved.sizeMul : 1 / Math.sqrt(s.w * s.h)).toFixed(6)),
        alphaMul: Number((solved ? solved.alphaMul : 1).toFixed(3)),
      },
    };
  }
  const json = {
    frames,
    meta: { app: 'pack_resources.cjs', image: 'res_atlas.png', format: 'RGBA8888', size: { w: ATLAS_W, h: ATLAS_H }, scale: '1' },
  };

  // Write byte-identical copies to every consumer (§5.8: client + map-editor)
  for (const dir of OUT_DIRS) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'res_atlas.png'), atlasBuf);
    fs.writeFileSync(path.join(dir, 'res_atlas.json'), JSON.stringify(json, null, 2));
  }

  const kb = (atlasBuf.length / 1024).toFixed(1);
  console.log(`✅ Packed ${sprites.length} frames → res_atlas.png (${ATLAS_W}×${ATLAS_H}, ${kb} KB) + res_atlas.json → ${OUT_DIRS.length} dir(s)`);
  console.table(sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, x: s.x, y: s.y })));
}

main().catch((e) => { console.error(e); process.exit(1); });
