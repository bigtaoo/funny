/**
 * pack_tab_icons.cjs — Process tabicon_*.{webp,png} source images (AI-generated, white background,
 * single dark-ink line art) into transparent PNGs, baking one recolored variant per ink the job asks
 * for (`INKS` below; the default set is the three tab inks):
 *   - `{name}_active.png`   — RGB overridden to white (#ffffff), for the active tab cell (dark fill).
 *   - `{name}_inactive.png` — RGB overridden to mid-grey (#686868, matches sketchUi.ts's `C.mid`),
 *                             for the inactive tab cell (paper fill).
 *   - `{name}_content.png`  — RGB overridden to ink-dark (#2c2c2a, matches sketchUi.ts's `C.dark`),
 *                             for icons used as CONTENT on paper rather than as a tab: reward rows
 *                             (see client/src/render/rewardIcon.ts) sit next to full-colour material
 *                             and coin bitmaps, and the de-emphasised tab grey read a notch washed
 *                             out beside them (2026-08-15 follow-up to batch 4). Same ink weight as
 *                             the primary text in the same row, so the picture reads as content.
 *   - `{name}_accent.png`   — RGB overridden to the blue affordance accent (#4477cc, `C.accent`),
 *                             for the back-button arrow on the paper title bar. Opt-in per job.
 *
 * This mirrors decos-b's pack_labels.cjs "bake the ink color at pack time" trick (there's no
 * runtime-tint-an-AI-PNG precedent in this codebase — vector icons tint live via PIXI Graphics
 * `color` param, but a raster asset needs the color baked into separate exports instead), just
 * emitting several colors per source instead of one — see design/product/tab-icon-art-prompts.md.
 *
 * Pipeline per source image:
 *   1. Load → compute alpha = 255 - luminance (white bg → transparent, ink → opaque, anti-aliased
 *      edges → semi-transparent), independently for each target color.
 *   2. Override RGB with the target ink color, keep the alpha computed in step 1.
 *   3. Crop surrounding whitespace using the content bounding box.
 *   4. Scale proportionally so the long edge = LONG_EDGE.
 *   5. Export one PNG per requested ink to client/src/assets/tabicons/ (dark-fill inks get
 *      `thicken` dilate passes first — see dilateAlpha).
 *
 * Usage:    node pack_tab_icons.cjs
 * Requires: reuses client/node_modules/sharp (no separate install needed).
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.resolve(__dirname, '../../../client/node_modules/sharp'));

const LONG_EDGE = 128;  // source is AI-res; runtime displays at ~28-40px, this leaves headroom
const ALPHA_TRIM = 16;

/**
 * Output suffix → baked ink + how many dilate passes that variant gets (see {@link dilateAlpha}).
 * Keep the three tab suffixes in sync with `RasterIconVariant` in client/src/render/icons.ts.
 *
 * Only inks meant for a DARK fill are thickened: a ~2px line at LONG_EDGE minified to the ~28px a
 * tab cell actually draws lands on well under one output pixel, so the downsampler averages the
 * stroke down to roughly half alpha. On paper that reads as a slightly lighter grey line and nobody
 * notices; white ink on the near-black active cell instead lands at ~#808080 — a mid-grey line on a
 * dark fill, which is the "the anvil tab is basically invisible" report of 19.08.2026. Measured over
 * all 46 kinds at 28px before the fix: peak alpha 55–76%, i.e. NOT ONE icon had a single fully
 * opaque pixel.
 *
 * `accent` is the blue affordance ink (`C.accent`), used by the back-button arrow on the paper title
 * bar — blue on cream is nowhere near as brutal as white on near-black, but the arrow draws smaller
 * than a tab cell does, so it takes the same treatment. Only jobs that ask for it get it (see JOBS'
 * `inks`); baking a 4th PNG for all 46 tab icons would be ~250KB of bundle nobody draws.
 */
const INKS = {
  active:   { r: 0xff, g: 0xff, b: 0xff, thicken: 1 }, // white   — active tab cell (dark fill)
  inactive: { r: 0x68, g: 0x68, b: 0x68, thicken: 0 }, // C.mid   — inactive tab cell (paper fill)
  content:  { r: 0x2c, g: 0x2c, b: 0x2a, thicken: 0 }, // C.dark  — content on paper (reward rows)
  accent:   { r: 0x44, g: 0x77, b: 0xcc, thicken: 1 }, // C.accent— back-button arrow on the paper bar
};

/** Inks a JOBS row gets when it doesn't name its own — the tab-icon triple. */
const DEFAULT_INKS = ['active', 'inactive', 'content'];

/**
 * One 3×3 max filter over the alpha channel of an RGBA raw buffer — grows every stroke by one pixel
 * in each direction, leaving RGB (the already-baked ink) alone.
 *
 * Applied at LONG_EDGE, so one pass is +1/128 of the icon's own size: invisible at the 64px+ a title
 * glyph draws at, but exactly the compensation a 28px tab cell needs — measured across the set it
 * takes peak alpha at 28px from 55–76% to a solid 100% and roughly doubles mean coverage, with the
 * line art still reading as line art. A second pass over the TAB icons was tried and rejected: the
 * shield's centre seam and the roster card's little swordsman start closing up (19.08.2026
 * side-by-side).
 *
 * How many passes a shape can take is a property of the shape, not a global constant — which is why
 * a JOBS row may override it. `back` (a bare arrow: one shaft, two head strokes, nothing but empty
 * paper between them) takes 3 without any risk of closing up, and needs them: it is a 2.06:1 shape,
 * so normalising its LONG edge leaves the stroke thinner relative to the box than a squarer icon of
 * the same drawn weight — 5.0px at LONG_EDGE, i.e. 0.94px once contain-fit into the ~24px box the
 * back button gives it.
 */
function dilateAlpha(buf, W, H) {
  const out = Buffer.from(buf);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const a = buf[(yy * W + xx) * 4 + 3];
          if (a > m) m = a;
        }
      }
      out[(y * W + x) * 4 + 3] = m;
    }
  }
  return out;
}

// Source file (in this dir) → asset name. Add a row here for each new tab icon pilot batch.
const JOBS = [
  { src: 'tabicon_roster.webp', name: 'roster' },
  { src: 'tabicon_equip.webp',  name: 'equip' },
  { src: 'tabicon_skin.webp',   name: 'skin' },
  // Batch 2 (design/product/tab-icon-art-prompts.md §batch2):
  { src: 'tabicon_stats.webp',      name: 'stats' },
  { src: 'tabicon_progress.webp',   name: 'progress' },
  { src: 'tabicon_honor.webp',      name: 'honor' },
  { src: 'tabicon_collection.webp', name: 'collection' },
  // Batch 3 (design/product/tab-icon-art-prompts.md §batch3):
  { src: 'tabicon_shop.webp',        name: 'shop' },
  { src: 'tabicon_coin.webp',        name: 'coin' },
  { src: 'tabicon_gacha.webp',       name: 'gacha' },
  { src: 'tabicon_recharge.webp',    name: 'recharge' },
  { src: 'tabicon_home.webp',        name: 'home' },
  { src: 'tabicon_social.webp',      name: 'social' },
  { src: 'tabicon_pvp.webp',         name: 'pvp' },
  { src: 'tabicon_bid.webp',         name: 'bid' },
  { src: 'tabicon_material.webp',    name: 'material' },
  { src: 'tabicon_achievement.webp', name: 'achievement' },
  { src: 'tabicon_battlepass.webp',  name: 'battlepass' },
  { src: 'tabicon_pve.webp',         name: 'pve' },
  // Batch 5 — scene titles + leftover sub-tabs (design/product/tab-icon-art-prompts-batch5.md):
  { src: 'tabicon_auction.webp',     name: 'auction' },
  { src: 'tabicon_city.webp',        name: 'city' },
  { src: 'tabicon_leaderboard.webp', name: 'leaderboard' },
  { src: 'tabicon_settings.webp',    name: 'settings' },
  { src: 'tabicon_event.webp',       name: 'event' },
  { src: 'tabicon_deck.webp',        name: 'deck' },
  { src: 'tabicon_room.webp',        name: 'room' },
  { src: 'tabicon_defense.webp',     name: 'defense' },
  { src: 'tabicon_checkin.webp',     name: 'checkin' },
  { src: 'tabicon_tasks.webp',       name: 'tasks' },
  { src: 'tabicon_weekly.webp',      name: 'weekly' },
  { src: 'tabicon_ads.webp',         name: 'ads' },
  { src: 'tabicon_friends.webp',     name: 'friends' },
  { src: 'tabicon_family.webp',      name: 'family' },
  { src: 'tabicon_sect.webp',        name: 'sect' },
  { src: 'tabicon_mail.webp',        name: 'mail' },
  { src: 'tabicon_bag.webp',         name: 'bag' },
  { src: 'tabicon_craft.webp',       name: 'craft' },
  { src: 'tabicon_all.webp',         name: 'all' },
  { src: 'tabicon_weapon.webp',      name: 'weapon' },
  { src: 'tabicon_armorslot.webp',   name: 'armorslot' },
  { src: 'tabicon_trinket.webp',     name: 'trinket' },
  { src: 'tabicon_avatar.webp',      name: 'avatar' },
  { src: 'tabicon_channel.webp',     name: 'channel' },
  // Batch 6 — lobby home-screen motifs (design/product/tab-icon-art-prompts-batch6.md). Unlike every
  // batch before it these are LARGE motifs (hero button watermark + pillar-card art, rendered at
  // hundreds of px), not 28px tab cells — the ink variants and the pipeline are unchanged, but the
  // source art is allowed a little more line detail (the map's dotted route, the notebook's spiral).
  { src: 'tabicon_duel.webp',        name: 'duel' },
  { src: 'tabicon_campaign.png',     name: 'campaign' },
  { src: 'tabicon_world.png',        name: 'world' },
  // Back-button arrow (19.08.2026) — NOT a tab icon: it is the affordance glyph inside the back
  // pill every secondary scene's title bar draws, so it takes the blue `accent` ink for the paper
  // bar plus `active` for LoginScene's dark title bar, and skips the two paper tab inks nothing
  // would draw. `thicken: 3` because a bare arrow can't close up and needs the extra weight at the
  // small box the back pill gives it — see dilateAlpha.
  { src: 'tabicon_back.png', name: 'back', inks: ['accent', 'active'], thicken: 3 },
  // Batch 7 (design/product/tab-icon-art-prompts-batch7.md, 2026-08-25) — everything the six
  // navigation batches left procedural: equipment affix/material glyphs, the generic UI dingbats a
  // dozen screens share, the SLG building + speedup-tier art, the five old fallback motifs, and the
  // 11-step title ladder. These draw at 20-28px (affix rows are the smallest icons in the game), so
  // they take the same `thicken: 1` default as the tab cells rather than batch 6's large-motif
  // treatment. The 11 `title*` rows are a PROGRESSION — see the doc's P7 note: each step only adds
  // one detail to the previous, so they must be reviewed as a set at 28px, not one at a time.
  //
  // `inks: ['active']` — ONE white master each, not the tab triple. Unlike a tab cell, every one of
  // these sites passes `buildIcon` a literal ink it means (LeaderboardScene tints `medal` gold/
  // silver/bronze per rank, GachaScene tints `star` per rarity, TitlesScene tints the ladder glyph
  // per owned/equipped state, HUDView wants `ink` in the faction blue), so they are runtime-TINTED
  // from the white art instead of picking a pre-baked grey — see icons/inkIconRaster.ts. Baking the
  // other two inks would be 88 PNGs nobody draws, and would quietly drop every one of those tints.
  { src: 'tabicon_atk.webp',               name: 'atk', inks: ['active'] },
  { src: 'tabicon_hp.webp',                name: 'hp', inks: ['active'] },
  { src: 'tabicon_armor.webp',             name: 'armor', inks: ['active'] },
  { src: 'tabicon_armorHeavy.webp',        name: 'armorHeavy', inks: ['active'] },
  { src: 'tabicon_spd.webp',               name: 'spd', inks: ['active'] },
  { src: 'tabicon_atkspd.webp',            name: 'atkspd', inks: ['active'] },
  { src: 'tabicon_scrap.webp',             name: 'scrap', inks: ['active'] },
  { src: 'tabicon_lead.webp',              name: 'lead', inks: ['active'] },
  { src: 'tabicon_binding.webp',           name: 'binding', inks: ['active'] },
  { src: 'tabicon_hammer.webp',            name: 'hammer', inks: ['active'] },
  { src: 'tabicon_ink.webp',               name: 'ink', inks: ['active'] },
  { src: 'tabicon_replay.webp',            name: 'replay', inks: ['active'] },
  { src: 'tabicon_share.webp',             name: 'share', inks: ['active'] },
  { src: 'tabicon_star.webp',              name: 'star', inks: ['active'] },
  { src: 'tabicon_lock.webp',              name: 'lock', inks: ['active'] },
  { src: 'tabicon_medal.webp',             name: 'medal', inks: ['active'] },
  { src: 'tabicon_close.webp',             name: 'close', inks: ['active'] },
  { src: 'tabicon_check.webp',             name: 'check', inks: ['active'] },
  { src: 'tabicon_play.webp',              name: 'play', inks: ['active'] },
  { src: 'tabicon_zoom.webp',              name: 'zoom', inks: ['active'] },
  { src: 'tabicon_cards.webp',             name: 'cards', inks: ['active'] },
  { src: 'tabicon_flag.webp',              name: 'flag', inks: ['active'] },
  { src: 'tabicon_desk.webp',              name: 'desk', inks: ['active'] },
  { src: 'tabicon_cabinet.webp',           name: 'cabinet', inks: ['active'] },
  { src: 'tabicon_hourglassSm.webp',       name: 'hourglassSm', inks: ['active'] },
  { src: 'tabicon_hourglassMd.webp',       name: 'hourglassMd', inks: ['active'] },
  { src: 'tabicon_hourglassLg.webp',       name: 'hourglassLg', inks: ['active'] },
  { src: 'tabicon_book.webp',              name: 'book', inks: ['active'] },
  { src: 'tabicon_globe.webp',             name: 'globe', inks: ['active'] },
  { src: 'tabicon_trophy.webp',            name: 'trophy', inks: ['active'] },
  { src: 'tabicon_castle.webp',            name: 'castle', inks: ['active'] },
  { src: 'tabicon_pencils.webp',           name: 'pencils', inks: ['active'] },
  { src: 'tabicon_titleBronze.webp',       name: 'titleBronze', inks: ['active'] },
  { src: 'tabicon_titleSilver.webp',       name: 'titleSilver', inks: ['active'] },
  { src: 'tabicon_titleGold.webp',         name: 'titleGold', inks: ['active'] },
  { src: 'tabicon_titlePlatinum.webp',     name: 'titlePlatinum', inks: ['active'] },
  { src: 'tabicon_titleDiamond.webp',      name: 'titleDiamond', inks: ['active'] },
  { src: 'tabicon_titleStar.webp',         name: 'titleStar', inks: ['active'] },
  { src: 'tabicon_titleMaster.webp',       name: 'titleMaster', inks: ['active'] },
  { src: 'tabicon_titleGrandmaster.webp',  name: 'titleGrandmaster', inks: ['active'] },
  { src: 'tabicon_titleKing.png',          name: 'titleKing', inks: ['active'] },
  { src: 'tabicon_titleChampion.png',      name: 'titleChampion', inks: ['active'] },
  { src: 'tabicon_titleTop3.png',          name: 'titleTop3', inks: ['active'] },

  // Batch 8 (design/product/tab-icon-art-prompts-batch8.md): the four stat words that never had a
  // glyph of any kind, procedural or otherwise — the codex's `range` and the three affix rows
  // (`siege`/`crit`/`critmult`). Same `inks: ['active']` contract as the block above: an affix line
  // tints its icon with the line's own colour (blue for a main affix, ink for a sub).
  // `crit` and `critmult` are ONE family — the same target and arrowhead, `critmult` adding the
  // impact strokes — so they are drawn in one request and reviewed side by side, never one at a time.
  { src: 'tabicon_range.webp',             name: 'range', inks: ['active'] },
  { src: 'tabicon_siege.webp',             name: 'siege', inks: ['active'] },
  { src: 'tabicon_crit.webp',              name: 'crit', inks: ['active'] },
  { src: 'tabicon_critmult.webp',          name: 'critmult', inks: ['active'] },

  // Batch 8b (same doc): the codex tile's type-and-cost subtitle. `unit` is a side-profile
  // Corinthian helmet (the front view came back as a knit beanie — see the doc), `spell` a rolled
  // scroll; the Building type reuses `castle` and the cost reuses `ink` (in battle, cost IS ink),
  // so those two draw no new art.
  { src: 'tabicon_unit.webp',              name: 'unit', inks: ['active'] },
  { src: 'tabicon_spell.webp',             name: 'spell', inks: ['active'] },

  // Batch 9 (design/product/tab-icon-art-prompts-batch9.md, 2026-09-02): the world-map tile modal's
  // remaining icon slots. Three of them are TILE STRUCTURES that had no ink-table art at all, so the
  // localised string carried an emoji as the marker (`world.hasWatchtower`/`hasArrowTower`/
  // `hasBlocker` were the last emoji left in that panel); the other four were borrowing a glyph that
  // meant something else (`globe` for coordinates, `unit` for garrison, `spd` for stay, `siege` for
  // the stronghold title).
  //
  // `watchtower`/`arrowTower`/`blocker` were drawn in ONE request and must stay that way on a
  // redraw: all three appear in the same build menu at once, so "tells them apart at 26px" is a
  // property of the SET, not of any one file (same rule as the hourglass tiers).
  //
  // NOT the same art as art/slg/slg-map/icon_{watchtower,blocker,arrowTower}.png, which exist and
  // mean the same things: those are realistic pen hatching for the isometric map layer, measured in
  // design/product/slg-building-art.md §6 as unreadable hatch mush at their own render size (~17-30px).
  // Same `inks: ['active']` contract as batches 7/8 — one white master, tinted at draw time.
  { src: 'tabicon_watchtower.png',         name: 'watchtower', inks: ['active'] },
  { src: 'tabicon_arrowTower.png',         name: 'arrowTower', inks: ['active'] },
  { src: 'tabicon_blocker.png',            name: 'blocker', inks: ['active'] },
  { src: 'tabicon_mapPin.webp',            name: 'mapPin', inks: ['active'] },
  { src: 'tabicon_camp.webp',              name: 'camp', inks: ['active'] },
  { src: 'tabicon_footsteps.webp',         name: 'footsteps', inks: ['active'] },
  { src: 'tabicon_stronghold.webp',        name: 'stronghold', inks: ['active'] },
];

const OUT_DIR = path.resolve(__dirname, '../../../client/src/assets/tabicons');

async function recolor(rawData, W, H, ch, ink, thicken) {
  const out = Buffer.alloc(W * H * 4);
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const r = rawData[i], g = rawData[i + 1], b = rawData[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let a = Math.round(255 - lum);
      if (a < 0) a = 0; else if (a > 255) a = 255;
      if (ch === 4) a = Math.min(a, rawData[i + 3]);
      const di = (y * W + x) * 4;
      out[di] = ink.r; out[di + 1] = ink.g; out[di + 2] = ink.b; out[di + 3] = a;
      if (a > ALPHA_TRIM) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // empty image (no content)

  const cropW = maxX - minX + 1, cropH = maxY - minY + 1;
  const cropBuf = Buffer.alloc(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const si = ((y + minY) * W + (x + minX)) * 4;
      const di = (y * cropW + x) * 4;
      cropBuf[di] = out[si]; cropBuf[di + 1] = out[si + 1];
      cropBuf[di + 2] = out[si + 2]; cropBuf[di + 3] = out[si + 3];
    }
  }

  // Thickened variants resize `thicken` pixels short on each edge and get those pixels back as
  // transparent padding below, so each dilate pass has somewhere to grow into (otherwise the strokes
  // that touch the crop box — most of them, the box IS the content bounds — grow off-canvas) and
  // every variant of a kind still exports at the same LONG_EDGE. The slightly smaller drawing inside
  // is exactly what the dilate gives back, so a tab flipping between inactive and active doesn't
  // resize its glyph.
  const scale = (LONG_EDGE - thicken * 2) / Math.max(cropW, cropH);
  const newW = Math.max(1, Math.round(cropW * scale));
  const newH = Math.max(1, Math.round(cropH * scale));
  const img = sharp(cropBuf, { raw: { width: cropW, height: cropH, channels: 4 } })
    .resize(newW, newH, { fit: 'fill' });
  if (!thicken) return { buf: await img.png().toBuffer(), w: newW, h: newH };

  const padW = newW + thicken * 2, padH = newH + thicken * 2;
  let padded = await img
    .extend({
      top: thicken, bottom: thicken, left: thicken, right: thicken,
      background: { r: ink.r, g: ink.g, b: ink.b, alpha: 0 },
    })
    .raw().toBuffer();
  for (let i = 0; i < thicken; i++) padded = dilateAlpha(padded, padW, padH);
  // Repaint the ink AFTER dilating. `dilateAlpha` only grows alpha, so the pixels it turns opaque
  // keep whatever RGB they already had — and sharp's resize (premultiply → unpremultiply) zeroes
  // the RGB of anything fully transparent, whatever `background` was passed. Skip this and every
  // thickened stroke gets a black fringe exactly `thicken` pixels wide: invisible on the near-black
  // active tab cell, which is why the first thickening pass shipped with it (19.08.2026), but the
  // blue back arrow on cream paper is three passes wide and reads as a black arrow with a blue core.
  for (let i = 0; i < padded.length; i += 4) {
    padded[i] = ink.r; padded[i + 1] = ink.g; padded[i + 2] = ink.b;
  }
  const buf = await sharp(padded, { raw: { width: padW, height: padH, channels: 4 } }).png().toBuffer();
  return { buf, w: padW, h: padH };
}

async function process(job) {
  const file = path.join(__dirname, job.src);
  if (!fs.existsSync(file)) {
    console.warn(`⚠️  skip ${job.name}: source not found (${job.src}) — drop the AI-generated file here first`);
    return [];
  }
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: ch } = info;

  const rows = [];
  for (const suffix of job.inks ?? DEFAULT_INKS) {
    const ink = INKS[suffix];
    if (!ink) throw new Error(`${job.name}: unknown ink '${suffix}' (known: ${Object.keys(INKS).join(', ')})`);
    // A job may override the per-ink pass count for shapes that can take more (or less) — see
    // dilateAlpha's note on `back`. `thicken: 0` inks stay unthickened regardless.
    const passes = ink.thicken === 0 ? 0 : (job.thicken ?? ink.thicken);
    const result = await recolor(data, W, H, ch, ink, passes);
    if (!result) throw new Error(`${job.name}: empty image (no content)`);
    const outName = `${job.name}_${suffix}.png`;
    // Quantized palette PNG (client/src/assets publish-bytes convention — see
    // art/scripts/exportUnitCardArt.mjs and claudedocs/file-formats.md): each output is one baked
    // ink color at varying alpha, trivially safe to quantize. This is the real final encode (not
    // the intermediate .png() in recolor() above, which sharp(result.buf) here decodes and re-writes).
    await sharp(result.buf).png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 }).toFile(path.join(OUT_DIR, outName));
    rows.push({ name: outName, w: result.w, h: result.h });
  }
  return rows;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];
  for (const job of JOBS) rows.push(...(await process(job)));
  if (!rows.length) {
    console.error('No source files found — see design/product/tab-icon-art-prompts.md for the prompts, drop AI output as tabicon_*.webp next to this script.');
    process.exit(1);
  }
  console.log(`✅ Packed ${rows.length} PNG(s) → ${OUT_DIR}`);
  console.table(rows);
}

main().catch((e) => { console.error(e); process.exit(1); });
