import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor, tearDownChildren } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { buildIcon, type IconKind } from '../../render/icons';
import { cardArtUrl, getArtTexture } from '../../render/cardArt';
import { UNIT_BLUEPRINTS, BUILDING_BLUEPRINTS } from '@nw/engine/config';
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
      { icon: 'hp', label: t('collection.stat.hp'), value: b.hp },
      { icon: 'atk', label: t('collection.stat.atk'), value: b.attack },
      { icon: null, label: t('collection.stat.range'), value: b.range },
    ];
  }
  if (card.cardType === CardType.Building && card.buildingType !== undefined) {
    const b = BUILDING_BLUEPRINTS[card.buildingType];
    const out: { icon: IconKind | null; label: string; value: number }[] = [
      { icon: 'hp', label: t('collection.stat.hp'), value: b.hp },
    ];
    if (b.attack !== undefined) {
      out.push({ icon: 'atk', label: t('collection.stat.atk'), value: b.attack });
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

export function drawStatChips(
  stats: { icon: IconKind | null; label: string; value: number }[],
  x: number, y: number, maxW: number, size: number, target: PIXI.Container,
): void {
  const row = new PIXI.Container();
  const gap = Math.round(size * 0.28);
  const chipGap = Math.round(size * 0.75);
  const valSize = snapFont(Math.round(size * 0.74));
  let cx = 0;
  stats.forEach((s, i) => {
    if (i > 0) cx += chipGap;
    if (s.icon) {
      const ic = buildIcon(s.icon, size, C.mid);
      ic.x = cx; ic.y = 0; row.addChild(ic);
      cx += size + gap;
    } else {
      const lbl = txt(s.label, valSize, C.mid);
      lbl.anchor.set(0, 0.5); lbl.x = cx; lbl.y = size / 2; row.addChild(lbl);
      cx += lbl.width + gap;
    }
    const val = txt(String(s.value), valSize, C.dark, true);
    val.anchor.set(0, 0.5); val.x = cx; val.y = size / 2; row.addChild(val);
    cx += val.width;
  });
  row.x = x; row.y = y;
  if (row.width > maxW) row.scale.set(maxW / row.width);
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
    drawStatChips(stats, textX, y + Math.round(h * 0.60), infoW - pad * 2, Math.round(h * 0.15), target);
  }
  return face;
}
