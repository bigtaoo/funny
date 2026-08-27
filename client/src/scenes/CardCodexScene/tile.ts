import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor, tearDownChildren } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { buildIcon, type IconKind } from '../../render/icons';
import { cardArtUrl, getArtTexture } from '../../render/cardArt';
import { UNIT_BLUEPRINTS, BUILDING_BLUEPRINTS } from '@nw/engine/config';
import { fromFp } from '@nw/engine/math/fixed';
import { CardType, type CardDefinition } from '@nw/engine/types';

// ── Pure codex-tile drawing helpers for CardCodexScene ────────────────────────
//
// Extracted from the scene class (form① partial split, client-modules.md's split-priority
// convention, same idiom as BattlePassScene/cell.ts): fully parameterized — art-load dedup
// (`artHooked`) and the re-render trigger (`onArtLoaded`) are passed in rather than read off
// `this`, and flip state (`flipped`) is a plain readonly Set rather than a scene field, so
// nothing here needs a scene instance. Only the flip *animation* (PIXI.Ticker registration/
// cleanup) and the row-virtualization scaffolding stay on the class.

export interface CodexEntry { card: CardDefinition; locked: boolean; }

/** Shared with CardCodexScene.flipTileAt() so it rebuilds the exact same face size. */
export function codexFaceBox(tileH: number): number {
  const inset = Math.round(tileH * 0.06);
  return tileH - inset * 2;
}

/** The card's story text for the flip's back face: the character lore when it exists, else the card blurb. */
export function storyText(card: CardDefinition): string {
  const loreKey = card.nameKey.replace(/\.name$/, '.lore');
  const lore = t(loreKey as TranslationKey);
  return lore !== loreKey ? lore : t(card.descKey as TranslationKey);
}

export function cardStats(card: CardDefinition): { icon: IconKind | null; label: string; value: number }[] | null {
  if (card.cardType === CardType.Unit && card.unitType !== undefined) {
    const b = UNIT_BLUEPRINTS[card.unitType];
    return [
      { icon: 'hp', label: t('collection.stat.hp'), value: fromFp(b.hp_fp) },
      { icon: 'atk', label: t('collection.stat.atk'), value: fromFp(b.attack_fp) },
      { icon: null, label: t('collection.stat.range'), value: b.range },
    ];
  }
  if (card.cardType === CardType.Building && card.buildingType !== undefined) {
    const b = BUILDING_BLUEPRINTS[card.buildingType];
    const out: { icon: IconKind | null; label: string; value: number }[] = [
      { icon: 'hp', label: t('collection.stat.hp'), value: fromFp(b.hp_fp) },
    ];
    if (b.attack_fp !== undefined) {
      out.push({ icon: 'atk', label: t('collection.stat.atk'), value: fromFp(b.attack_fp) });
      if (b.attackRange !== undefined) out.push({ icon: null, label: t('collection.stat.range'), value: b.attackRange });
    }
    return out;
  }
  return null;
}

/** Fit-scaled art sprite; `artHooked` dedups the one-shot 'loaded' listener per URL across
 *  repeated calls, `onArtLoaded` is the caller's re-render trigger once the texture is ready. */
export function drawArtFit(
  url: string, x: number, y: number, box: number, target: PIXI.Container,
  artHooked: Set<string>, onArtLoaded: () => void,
): void {
  const tex = getArtTexture(url);
  if (!tex.baseTexture.valid) {
    if (!artHooked.has(url)) {
      artHooked.add(url);
      tex.baseTexture.once('loaded', onArtLoaded);
    }
    return;
  }
  const scale = Math.min(box / tex.width, box / tex.height);
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(0.5);
  sp.scale.set(scale);
  sp.position.set(x + box / 2, y + box / 2);
  target.addChild(sp);
}

/** Draw the illustration face: art (front) or word-wrapped story text (back), centred on the container origin. */
export function drawTileFace(
  container: PIXI.Container, box: number, card: CardDefinition, art: string | null, story: string, showStory: boolean,
  artHooked: Set<string>, onArtLoaded: () => void,
): void {
  tearDownChildren(container);
  if (!showStory) {
    if (art) { drawArtFit(art, -box / 2, -box / 2, box, container, artHooked, onArtLoaded); return; }
    // No illustration for this card yet — a faded monogram keeps the frame from reading as broken.
    const initial = t(card.nameKey as TranslationKey).charAt(0).toUpperCase();
    const mono = txt(initial, snapFont(Math.round(box * 0.5)), C.mid, true);
    mono.anchor.set(0.5, 0.5); mono.alpha = 0.35;
    container.addChild(mono);
    return;
  }
  const bg = new PIXI.Graphics();
  bg.beginFill(0xf7f5ee).drawRect(-box / 2, -box / 2, box, box).endFill();
  container.addChild(bg);
  const lore = txt(story, snapFont(Math.round(box * 0.085)), C.mid);
  lore.style.wordWrap = true;
  lore.style.wordWrapWidth = box - 12;
  lore.x = -box / 2 + 6; lore.y = -box / 2 + 6;
  container.addChild(lore);
}

/** Greedy split of `chips` into `n` consecutive lines of roughly equal width; returns the widest line. */
function widestLineOf(chips: { w: number }[], chipGap: number, n: number): number {
  const total = chips.reduce((a, c) => a + c.w, 0) + chipGap * (chips.length - 1);
  const target = total / n;
  let widest = 0;
  let lineW = 0;
  let lines = 1;
  for (const c of chips) {
    const next = lineW > 0 ? lineW + chipGap + c.w : c.w;
    if (lineW > 0 && next > target && lines < n) { widest = Math.max(widest, lineW); lineW = c.w; lines++; }
    else lineW = next;
  }
  return Math.max(widest, lineW);
}

export function drawStatChips(
  stats: { icon: IconKind | null; label: string; value: number }[],
  x: number, y: number, maxW: number, maxH: number, size: number, target: PIXI.Container,
): void {
  const row = new PIXI.Container();
  const gap = Math.round(size * 0.28);
  const chipGap = Math.round(size * 0.75);
  const valSize = snapFont(Math.round(size * 0.74));

  // Each chip is built into its own container so it stays one unbreakable unit when the row wraps.
  const chips = stats.map((s) => {
    const chip = new PIXI.Container();
    let cx = 0;
    if (s.icon) {
      const ic = buildIcon(s.icon, size, C.mid);
      ic.x = cx; ic.y = 0; chip.addChild(ic);
      cx += size + gap;
    }
    // Every chip spells its stat out in words, icon or no icon: the icon is a redundant cue on top of
    // the name, never a replacement for it. Before this, `hp`/`atk` drew icon-only while `range` (no
    // art for it yet) drew name-only, so one row mixed two shapes of chip and the two icons had to be
    // learned rather than read (2026-08-27 user feedback on a codex screenshot).
    const lbl = txt(s.label, valSize, C.mid);
    lbl.anchor.set(0, 0.5); lbl.x = cx; lbl.y = size / 2; chip.addChild(lbl);
    cx += lbl.width + gap;
    const val = txt(String(s.value), valSize, C.dark, true);
    val.anchor.set(0, 0.5); val.x = cx; val.y = size / 2; chip.addChild(val);
    return { chip, w: cx + val.width };
  });

  // Spelling the stats out made the row ~1/3 wider, and portrait's info panel is narrow enough that
  // the old shrink-the-whole-row-to-fit dropped the text to about half the size of the name above it.
  // So trade width for height instead: pick the line count whose fit-scale (bounded by the panel's
  // width AND by the space left below the row's top edge) comes out largest — one line at full size
  // in landscape, two slightly-shrunk lines in portrait, three only if even that won't fit.
  let best = { n: 1, scale: 0 };
  for (let n = 1; n <= chips.length; n++) {
    const scale = Math.min(1, maxW / widestLineOf(chips, chipGap, n), maxH / (n * size));
    if (scale > best.scale + 1e-6) best = { n, scale };
  }
  const lineCap = widestLineOf(chips, chipGap, best.n) * best.scale;

  let lineW = 0;
  let lineY = 0;
  for (const { chip, w } of chips) {
    if (lineW > 0 && (lineW + chipGap + w) * best.scale > lineCap + 1e-6) { lineY += size; lineW = 0; }
    chip.x = lineW > 0 ? lineW + chipGap : 0;
    chip.y = lineY;
    lineW = chip.x + w;
    row.addChild(chip);
  }
  row.x = x; row.y = y;
  row.scale.set(best.scale);
  target.addChild(row);
}

/**
 * A read-only codex tile: a full-height illustration on the left (tap-to-flip → story text, when
 * unlocked) and a separate info panel on the right (name + type·cost header, key stats). Locked
 * entries grey out, show a lock over the art, and don't flip. `target` is the tile's row
 * container (row-local coordinates, y=0 at the row's top). Returns the built face container only
 * when unlocked — the caller (CardCodexScene.updateVisibleTiles) records it for flipTileAt() to
 * find later; this module doesn't know about `tileRows`/`faces` bookkeeping.
 */
export function drawCardTile(
  entry: CodexEntry, x: number, y: number, w: number, h: number, target: PIXI.Container,
  flipped: ReadonlySet<string>, artHooked: Set<string>, onArtLoaded: () => void,
): PIXI.Container | null {
  const { card, locked } = entry;
  const accent = locked ? C.mid
    : card.cardType === CardType.Unit ? C.accent
    : card.cardType === CardType.Building ? C.gold : C.red;

  const key = card.nameKey;
  const art = cardArtUrl(card);
  const story = storyText(card);

  // ── Illustration (left, full tile height) ──
  const imgBox = h;
  const frame = sketchPanel(imgBox, h, { fill: locked ? 0xf0efe9 : 0xf7f5ee, border: locked ? C.mid : C.line, width: 1.6, seed: seedFor(x, y, imgBox) });
  frame.x = x; frame.y = y;
  target.addChild(frame);

  const inset = Math.round(imgBox * 0.06);
  const faceBox = imgBox - inset * 2;
  const face = new PIXI.Container();
  face.position.set(x + imgBox / 2, y + h / 2);
  target.addChild(face);
  drawTileFace(face, faceBox, card, art, story, !locked && flipped.has(key), artHooked, onArtLoaded);

  if (locked) {
    const dim = new PIXI.Graphics();
    dim.beginFill(0xf0efe9, 0.55).drawRect(x + inset, y + inset, faceBox, faceBox).endFill();
    target.addChild(dim);
    const lkSize = Math.round(imgBox * 0.28);
    const lk = buildIcon('lock', lkSize, C.mid);
    lk.x = x + (imgBox - lkSize) / 2; lk.y = y + (h - lkSize) / 2;
    target.addChild(lk);
  }

  // ── Info panel (right, its own separately-drawn background) ──
  const infoGap = Math.round(w * 0.03);
  const infoX = x + imgBox + infoGap;
  const infoW = w - imgBox - infoGap;
  const info = sketchPanel(infoW, h, { fill: locked ? 0xf0efe9 : C.paper, border: locked ? C.mid : C.line, width: 1.6, seed: seedFor(infoX, y, infoW) });
  info.x = infoX; info.y = y;
  sketchAccentBar(info, h, accent, seedFor(infoX, h, 6));
  target.addChild(info);

  const pad = Math.round(infoW * 0.06);
  const textX = infoX + pad;

  const name = txt(t(card.nameKey as TranslationKey), snapFont(Math.round(h * 0.15)), locked ? C.mid : C.dark, true);
  name.anchor.set(0, 0); name.x = textX; name.y = y + Math.round(h * 0.12);
  // Belt-and-suspenders against a long localized name outrunning the panel (mirrors the shrink-to-fit
  // guard HubTabs.ts already applies to its own nav labels) — the tileH fix above is the real cure,
  // this just makes sure nothing overflows even at the width's edge case.
  const maxNameW = infoW - pad * 2;
  if (name.width > maxNameW) name.scale.set(maxNameW / name.width);
  target.addChild(name);

  const typeLabel = card.cardType === CardType.Unit ? t('collection.cardType.unit')
    : card.cardType === CardType.Building ? t('collection.cardType.building')
    : t('collection.cardType.spell');
  const sub = txt(`${typeLabel} · ${t('collection.stat.cost')} ${card.cost}`, snapFont(Math.round(h * 0.12)), accent, true);
  sub.anchor.set(0, 0); sub.x = textX; sub.y = y + Math.round(h * 0.34);
  target.addChild(sub);

  if (locked) {
    const lockedLbl = txt(t('collection.locked'), snapFont(Math.round(h * 0.11)), C.mid, true);
    lockedLbl.anchor.set(0, 0); lockedLbl.x = textX; lockedLbl.y = y + Math.round(h * 0.62);
    target.addChild(lockedLbl);
    return null;
  }

  const stats = cardStats(card);
  if (stats) {
    const statsY = Math.round(h * 0.60);
    // Height budget: from the row's top edge down to the panel's bottom padding — the row wraps
    // onto a second line in portrait, and without a ceiling the third line would spill out of the tile.
    drawStatChips(stats, textX, y + statsY, infoW - pad * 2, Math.round(h * 0.94) - statsY, Math.round(h * 0.15), target);
  }
  return face;
}
