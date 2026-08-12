import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import { PlayerStats } from '@nw/engine/types';
import { t, TranslationKey } from '../../i18n';
import type { ProfilePopup, ProfileData } from '../../ui/dialogs/ProfilePopup';
import { ui, sketchPanel, seedFor } from '../../render/sketchUi';
import { buildIcon, IconKind } from '../../render/icons';
import { SketchPen } from '../../render/sketch';
import { getTitleKeys, formatLadderTitle } from '../../game/meta/titles';
import { getDecorTexture, isDecorReady, decorFrameNames } from '../../render/atlas/decorAtlas';
import { bake } from '../../render/bake';
import { Prng } from '@nw/engine/math/prng';
import { drawSceneHeader, type SceneHeaderResult } from '../../ui/widgets/SceneHeader';
import { FS, snapFont } from '../../render/fontScale';
import type { Badge } from '../ResultScene';

// ── Pure(ish) builder helpers for ResultScene ─────────────────────────────────
//
// Extracted from the scene class (form① partial split, client-modules.md §split
// convention): every scene-state read (container/popup/w/h) is now an explicit
// param instead of `this.*`, so these are free functions. `build()` — the real
// orchestrator — and the recursive `buildOutroOverlay` stay on the class.

/** A-group doodles scattered in the left/right paper margins, mirroring the battle-scene look. */
export function buildMarginDeco(w: number, h: number): PIXI.Container | null {
  if (!isDecorReady()) return null;
  const frames = decorFrameNames();
  if (frames.length === 0) return null;

  const bandW = Math.round(w * 0.11);
  const bandY = Math.round(h * 0.12);
  const bandH = Math.round(h * 0.72);
  const size  = Math.max(16, Math.min(64, Math.round(bandW * 0.72)));
  const pitch = size * 1.9;
  const slots = Math.floor(bandH / pitch);
  const frand = (p: Prng) => p.nextInt(1_000_000) / 1_000_000;
  const prng  = new Prng(0xDEAD_BEEF);

  const content = new PIXI.Container();
  for (const side of ['left', 'right'] as const) {
    const bandX = side === 'left' ? 0 : w - bandW;
    for (let i = 0; i < slots; i++) {
      if (frand(prng) < 0.15) continue;
      const name = frames[prng.nextInt(frames.length)]!;
      const tex  = getDecorTexture(name);
      if (!tex) continue;

      const spr = new PIXI.Sprite(tex);
      spr.anchor.set(0.5);
      const longest = Math.max(tex.width, tex.height) || size;
      spr.scale.set((size * (1 + (frand(prng) * 2 - 1) * 0.3)) / longest);
      spr.rotation = (frand(prng) * 2 - 1) * 0.22;
      spr.alpha    = 0.30 + frand(prng) * 0.20;
      spr.x = bandX + bandW / 2 + (frand(prng) * 2 - 1) * bandW * 0.25;
      spr.y = bandY + pitch * i  + frand(prng) * pitch * 0.5;
      content.addChild(spr);
    }
  }

  if (content.children.length === 0) { content.destroy(); return null; }

  const root = new PIXI.Container();
  root.interactiveChildren = false;
  const tex = bake(`result-margin:${Math.round(w)}x${Math.round(h)}`, content, w, h);
  content.destroy({ children: true });
  if (tex) root.addChild(new PIXI.Sprite(tex));
  return root;
}

/**
 * A small vertical badge medallion — glyph over its title over the bare stat
 * value. The container origin is the horizontal centre / top, so callers set
 * `.x` to the intended centre and `.y` to the top edge.
 */
export function buildBadgeMedallion(badge: Badge, stats: PlayerStats, h: number): PIXI.Container {
  const c = new PIXI.Container();

  const iconSize = Math.round(h * 0.065);
  const glyph = buildIcon(badge.icon, iconSize, 0x555555);
  glyph.x = -iconSize / 2;
  glyph.y = 0;
  c.addChild(glyph);

  const title = makeText(badge.title(), {
    fontSize: FS.heading,
    fill: 0x555555,
    fontFamily: 'monospace',
  });
  title.anchor.set(0.5, 0);
  title.x = 0;
  title.y = iconSize + h * 0.008;
  c.addChild(title);

  const value = makeText(badge.value(stats), {
    fontSize: FS.title,
    fill: 0x222222,
    fontWeight: 'bold',
    fontFamily: 'monospace',
  });
  value.anchor.set(0.5, 0);
  value.x = 0;
  value.y = title.y + title.height + h * 0.004;
  c.addChild(value);

  return c;
}

/** Hand-drawn margin doodles that react to the result; drawn low in the z-order. */
export function addMoodDeco(container: PIXI.Container, w: number, h: number, mood: 'win' | 'loss' | 'draw'): void {
  const g = new PIXI.Graphics();
  const pen = new SketchPen(g, 0x9e3 + (mood === 'win' ? 1 : mood === 'loss' ? 2 : 3));

  if (mood === 'win') {
    // A scatter of celebratory hand-drawn five-point stars in warm marker-gold.
    const gold = ui.gold;
    const star = (cx: number, cy: number, r: number, alpha: number): void => {
      const inner = r * 0.42;                     // classic 5-point star waist
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < 5; i++) {
        const ao = -Math.PI / 2 + (i * 2 * Math.PI) / 5;   // outer tip
        const ai = ao + Math.PI / 5;                       // inner notch
        pts.push({ x: cx + Math.cos(ao) * r, y: cy + Math.sin(ao) * r });
        pts.push({ x: cx + Math.cos(ai) * inner, y: cy + Math.sin(ai) * inner });
      }
      // Close the loop by hand — overshoot back past the first tip.
      pts.push(pts[0]!, pts[1]!);
      pen.stroke(pts, { color: gold, width: Math.max(1.4, r * 0.13), jitter: 0.35, taper: 0.9, double: false, alpha });
    };
    // Scattered inside the content frame only — never out to the page edges,
    // so nothing bleeds into the margins. Position is re-rolled on every view;
    // a minimum-distance floor between picks keeps them from clumping into one
    // bright patch. Each star's centre is inset by its own radius (see below)
    // so the whole star, not just its centre, stays within the frame.
    const starCount = 6;
    // Inner frame bounds (fractions of the page) the stars must stay within.
    const frameL = w * 0.13;
    const frameR = w * 0.87;
    const frameT = h * 0.13;
    const frameB = h * 0.94;
    const minDist = Math.min(w, h) * 0.1;
    const placed: { x: number; y: number }[] = [];
    for (let i = 0; i < starCount; i++) {
      const sr = h * (0.028 + Math.random() * 0.034);
      // Sampling box inset by the star radius so tips don't cross the frame.
      const loX = frameL + sr, hiX = frameR - sr;
      const loY = frameT + sr, hiY = frameB - sr;
      let sx = 0;
      let sy = 0;
      for (let attempt = 0; attempt < 20; attempt++) {
        sx = loX + Math.random() * (hiX - loX);
        sy = loY + Math.random() * (hiY - loY);
        if (placed.every((p) => Math.hypot(p.x - sx, p.y - sy) >= minDist)) break;
      }
      placed.push({ x: sx, y: sy });
      // Celebratory stars are faded to 38% opacity so they read as a soft
      // backdrop behind the result text rather than competing with it.
      const sa = (0.6 + Math.random() * 0.35) * 0.38;
      star(sx, sy, sr, sa);
    }
  } else if (mood === 'loss') {
    // A couple of red cross-out scribbles (echoes the "red-pen" art motif).
    const red = ui.red;
    // Red cross-out scribbles upper-right.
    const xout = (cx: number, cy: number, s: number, alpha: number): void => {
      pen.line(cx - s, cy - s * 0.6, cx + s, cy + s * 0.6, { color: red, width: Math.max(1.6, s * 0.18), jitter: 0.6, taper: 0.85, double: false, alpha });
      pen.line(cx - s, cy + s * 0.6, cx + s, cy - s * 0.6, { color: red, width: Math.max(1.6, s * 0.18), jitter: 0.6, taper: 0.85, double: false, alpha });
    };
    xout(w * 0.82, h * 0.22, h * 0.05,  0.60);
    xout(w * 0.88, h * 0.34, h * 0.035, 0.50);
    xout(w * 0.12, h * 0.18, h * 0.042, 0.50);
    xout(w * 0.14, h * 0.72, h * 0.036, 0.42);
    xout(w * 0.86, h * 0.60, h * 0.030, 0.38);
  } else {
    // Draw — a neutral hand-drawn equals/tilde mark in the corner.
    const ink = ui.line;
    pen.line(w * 0.80, h * 0.20, w * 0.90, h * 0.20, { color: ink, width: Math.max(2, h * 0.01), jitter: 0.5, taper: 0.9, double: false, alpha: 0.6 });
    pen.line(w * 0.80, h * 0.24, w * 0.90, h * 0.24, { color: ink, width: Math.max(2, h * 0.01), jitter: 0.5, taper: 0.9, double: false, alpha: 0.6 });
  }

  container.addChild(g);
}

/** Optional "「title」" sub-line centred at centerX beneath a name. */
export function addTitleSub(container: PIXI.Container, h: number, data: ProfileData, centerX: number, top: number): number {
  if (!data.equippedTitle) return top;
  const keys = getTitleKeys(data.equippedTitle);
  const titleLabel = keys
    ? t(keys.shortKey as TranslationKey) || formatLadderTitle(data.equippedTitle)
    : formatLadderTitle(data.equippedTitle);
  const sub = makeText(`「${titleLabel}」`, {
    fontSize: FS.label,
    fill: 0x8a7020,
    fontFamily: 'monospace',
  });
  sub.anchor.set(0.5, 0);
  sub.x = centerX;
  sub.y = top + h * 0.004;
  container.addChild(sub);
  return sub.y + sub.height;
}

/** A centred, tappable "name #id" line that opens its profile card. Returns new bottom y. */
export function addProfileLine(
  container: PIXI.Container, popup: ProfilePopup, w: number, h: number,
  label: string, top: number, data: ProfileData, color: number,
): number {
  const line = makeText(label, {
    fontSize: FS.title,
    fill: color,
    fontFamily: 'monospace',
    fontWeight: 'bold',
  });
  line.anchor.set(0.5, 0);
  line.x = w / 2;
  line.y = top + h * 0.018;
  line.eventMode = 'static';
  line.cursor = 'pointer';
  line.on('pointertap', () => popup.show(data));
  container.addChild(line);
  return addTitleSub(container, h, data, w / 2, line.y + line.height);
}

/**
 * Single centred versus line: "local (you)  vs  opponent". Each name is
 * tappable to open its profile popup; the "vs" separator sits between them in
 * a neutral grey. Any equipped titles render beneath their respective names.
 */
export function addVersusLine(
  container: PIXI.Container, popup: ProfilePopup, w: number, h: number,
  local: ProfileData, opp: ProfileData, top: number,
): number {
  const y = top + h * 0.018;
  const makeName = (label: string, color: number, data: ProfileData): PIXI.Text => {
    const txt = makeText(label, {
      fontSize: FS.title,
      fill: color,
      fontFamily: 'monospace',
      fontWeight: 'bold',
    });
    txt.anchor.set(0, 0);
    txt.eventMode = 'static';
    txt.cursor = 'pointer';
    txt.on('pointertap', () => popup.show(data));
    return txt;
  };
  const leftTxt = makeName(local.name + ' ' + t('profile.you'), 0x2c2c2a, local);
  const vsTxt = makeText('vs', {
    fontSize: FS.title,
    fill: 0x888888,
    fontFamily: 'monospace',
    fontWeight: 'bold',
  });
  vsTxt.anchor.set(0, 0);
  const rightTxt = makeName(opp.name, 0xaa2222, opp);

  const gap = Math.round(w * 0.022);
  const totalW = leftTxt.width + gap + vsTxt.width + gap + rightTxt.width;
  let x = (w - totalW) / 2;
  const rowH = Math.max(leftTxt.height, vsTxt.height, rightTxt.height);
  for (const txt of [leftTxt, vsTxt, rightTxt]) {
    txt.x = x;
    txt.y = y + (rowH - txt.height) / 2;
    container.addChild(txt);
    x += txt.width + gap;
  }

  const bottom = y + rowH;
  return Math.max(
    addTitleSub(container, h, local, leftTxt.x + leftTxt.width / 2, bottom),
    addTitleSub(container, h, opp, rightTxt.x + rightTxt.width / 2, bottom),
  );
}

/** Centre an icon + label pair inside the button box. */
export function addIconLabel(
  container: PIXI.Container,
  x: number, y: number, w: number, h: number,
  text: string, icon: IconKind, color: number, fontSize: number, bold: boolean,
): void {
  const iconSize = Math.round(h * 0.62);
  const label = makeText(text, {
    fontSize,
    fill: color,
    fontWeight: bold ? 'bold' : 'normal',
    fontFamily: 'monospace',
  });
  label.anchor.set(0, 0.5);

  const gap = Math.round(w * 0.04);
  const totalW = iconSize + gap + label.width;
  const startX = x + (w - totalW) / 2;

  const glyph = buildIcon(icon, iconSize, color);
  glyph.x = startX;
  glyph.y = y + (h - iconSize) / 2;

  label.x = startX + iconSize + gap;
  label.y = y + h / 2;

  container.addChild(glyph, label);
}

/** Primary call-to-action: gold-filled, bold white label with a leading icon. */
export function addPrimaryButton(
  container: PIXI.Container,
  x: number, y: number, w: number, h: number, text: string, icon: IconKind, onTap: () => void,
): void {
  const bg = sketchPanel(w, h, { fill: ui.gold, border: 0x6a5000, width: 2.6, seed: seedFor(x, y, w) });
  bg.x = x;
  bg.y = y;
  bg.eventMode = 'static';
  bg.cursor = 'pointer';
  bg.name = 'resultPrimaryCta'; // test hook — see test/ui/scenes.ui.ts "outro tap-through"
  bg.on('pointertap', onTap);
  container.addChild(bg);
  addIconLabel(container, x, y, w, h, text, icon, 0xfffdf4, snapFont(Math.round(h * 0.40)), true);
}

/** Quieter secondary entry: paper-fill ghost panel, ink line border + ink label/icon. */
export function addSecondaryButton(
  container: PIXI.Container,
  x: number, y: number, w: number, h: number, text: string, icon: IconKind, onTap: () => void,
): void {
  const bg = sketchPanel(w, h, { fill: ui.paper, border: ui.line, width: 1.8, seed: seedFor(x, y, w) });
  bg.x = x;
  bg.y = y;
  bg.eventMode = 'static';
  bg.cursor = 'pointer';
  bg.name = `resultSecondary:${icon}`; // test hook — see test/ui/scenes.ui.ts "outro tap-through"
  bg.on('pointertap', onTap);
  container.addChild(bg);
  addIconLabel(container, x, y, w, h, text, icon, 0x444444, snapFont(Math.round(h * 0.34)), false);
}

/**
 * Standard title bar (shared {@link drawSceneHeader} chrome — paper fill,
 * accent rule, embedded back pill), same as shop/gacha/equipment/etc. The
 * helper only draws the chrome and returns the back button's hit rect — it
 * does not wire up interactivity, since most callers run their own manual
 * hit-testing pipeline. This scene uses plain PIXI interactive/pointertap
 * everywhere else, so lay a transparent hit-area graphic over the chip instead.
 */
export function addHeader(container: PIXI.Container, w: number, h: number, onTap: () => void): SceneHeaderResult {
  const hdr = drawSceneHeader(container, w, h, null);
  const hit = new PIXI.Graphics();
  hit.beginFill(0x000000, 0.001);
  hit.drawRect(hdr.backRect.x, hdr.backRect.y, hdr.backRect.w, hdr.backRect.h);
  hit.endFill();
  hit.eventMode = 'static';
  hit.cursor = 'pointer';
  hit.name = 'resultBackChip'; // test hook — see test/ui/scenes.ui.ts "top-left back chip"
  hit.on('pointertap', onTap);
  container.addChild(hit);
  return hdr;
}
