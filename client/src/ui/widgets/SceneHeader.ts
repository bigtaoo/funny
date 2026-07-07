/**
 * SceneHeader.ts — the one true title bar + back button for every secondary
 * (non-lobby) menu scene. See `UI_DESIGN.md` §3.1 (back-button hard spec) and
 * §2.1 (draw-once caching).
 *
 * Before this, ~20 scenes each hand-placed their own back text: different x
 * (4% vs 5% vs hard-coded 10px), different font size, different hit-rect width
 * (fixed 80 vs `text.width + pad` vs 22% of screen), and a private `xxx.back`
 * i18n key per scene. This pins all of that:
 *
 *   - position : back glyph at x = 10 (design px), vertically centred in the bar
 *   - label    : '← ' + t('common.back'), drawn in the blue affordance accent
 *   - hit area : { x: 0, y: 0, w: 160, h: headerH } — larger than the glyph so
 *                it is comfortable to tap
 *   - title    : centred in the bar
 *
 * The bar chrome (dark fill + back glyph) is identical for every scene of a
 * given orientation, so it is baked once via {@link getCachedDisplay} and reused
 * as a sprite; only the per-scene title is drawn live on top.
 *
 * Usage (each scene keeps its own hit-testing array):
 *
 *   const hdr = drawSceneHeader(this.container, w, h, t('achievement.title'));
 *   this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });
 *   // lay out content below hdr.headerH
 *
 * Scenes that exempt themselves from the back-button convention (LobbyScene uses
 * the bottom NavBar; GameScene uses pause/exit) do NOT use this.
 */
import * as PIXI from 'pixi.js-legacy';
import type { Rect } from '../../layout/ILayout';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { getCachedDisplay } from './uiCache';
import { buildIcon, type IconKind } from '../../render/icons';
import { buildCoinIcon } from '../../render/coinIconAtlas';

/**
 * Bar styling. As of the 07.07.2026 header-unification pass, **every** secondary
 * scene uses `'paper'` — a hand-drawn paper panel (paper fill + mid sketch
 * border) with a dark title, matching the notebook aesthetic and the paper body
 * background all these scenes already sit on. Category is conveyed only by the
 * thin accent rule along the bottom of the bar (see `opts.accent`), not by the
 * fill colour, so the whole app reads as one consistent title row.
 *
 *   - 'paper' : the unified look (default). The right side of the bar is left
 *               free, so callers may draw their own controls (a coin readout via
 *               {@link drawHeaderCurrency}, or e.g. DefenseEditor's level stepper)
 *               on top of the baked chrome after this returns.
 *   - 'dark'  : legacy solid-dark fill + white title. Retained only so an
 *               explicit `variant: 'dark'` still compiles; no scene ships it.
 */
export type SceneHeaderVariant = 'dark' | 'paper';

/**
 * Category accent for the bottom rule of the bar. Blue = lobby / info / social
 * (default), gold = spend / progression (shop, gacha, battle pass, equipment,
 * roster), red = SLG / competitive (world, family, sect, teams, auction,
 * defense). Keeps the fill uniform while giving a faint at-a-glance zone cue.
 */
export const HEADER_ACCENT = {
  lobby: C.accent,
  spend: C.gold,
  slg: C.red,
} as const;

/** Hit-area width of the back button in design space (§3.1). */
const BACK_HIT_W = 160;
/** Left inset of the back glyph in design space (§3.1: x = 10). */
const BACK_X = 10;

/** Standard title-bar height (12% of design height), matching the legacy scenes. */
export function sceneHeaderHeight(h: number): number {
  return Math.round(h * 0.12);
}

export interface SceneHeaderResult {
  /** Title-bar height; lay scene content out below this y. */
  headerH: number;
  /** Back-button hit area to register with the scene's own hit testing. */
  backRect: Rect;
}

/** Back-glyph font size — kept in one place so every scene's back reads alike. */
function backSize(h: number): number {
  return Math.round(h * 0.026);
}

/** Chip fill for the back-button pill, keyed by where it sits. */
type BackChipContext = SceneHeaderVariant | 'floating';

/**
 * Measure a back-button label at `size` without drawing it (headless-safe).
 * Used to size the pill chip before baking the chrome.
 */
function measureBackLabel(label: string, size: number): { w: number; h: number } {
  const node = txt(label, size, C.accent);
  const dims = { w: node.width, h: node.height };
  node.destroy({ texture: true, baseTexture: true });
  return dims;
}

/** Chip padding + overall (w,h) around the back label — shared by the builder and callers that need the size before a cache-miss draw runs. */
function backChipSize(label: string, size: number): { padX: number; padY: number; w: number; h: number } {
  const { w: labelW, h: labelH } = measureBackLabel(label, size);
  const padX = Math.round(size * 0.7);
  const padY = Math.round(size * 0.5);
  return { padX, padY, w: labelW + padX * 2, h: labelH + padY * 2 };
}

/**
 * Build the back-button "pill": a lightweight rounded-rect chip behind the
 * label so the tap target reads as a button rather than bare text floating
 * on the bar (see the 05.07.2026 back-button unification pass). Deliberately
 * *not* the hand-drawn `sketchPanel` border used for real buttons elsewhere
 * (§7.5) — this is a subtle underlay, not a primary action button.
 */
function buildBackChip(label: string, size: number, ctx: BackChipContext): { chip: PIXI.Container; w: number; h: number } {
  const { padX, w, h } = backChipSize(label, size);

  const chip = new PIXI.Container();
  const bg = new PIXI.Graphics();
  const [fill, alpha] = ctx === 'paper' ? [C.dark, 0.08] : ctx === 'floating' ? [C.paper, 0.92] : [0xffffff, 0.12];
  bg.beginFill(fill, alpha);
  bg.drawRoundedRect(0, 0, w, h, Math.round(h * 0.32));
  bg.endFill();
  chip.addChild(bg);

  const lbl = txt(label, size, C.accent);
  lbl.anchor.set(0, 0.5);
  lbl.x = padX;
  lbl.y = h / 2;
  chip.addChild(lbl);

  return { chip, w, h };
}

/** Build the static bar chrome (fill + accent rule + back chip) at local origin. */
function buildChrome(
  w: number, headerH: number, label: string, size: number, variant: SceneHeaderVariant, accent: number,
): PIXI.Container {
  const c = new PIXI.Container();

  if (variant === 'paper') {
    c.addChild(sketchPanel(w, headerH, { fill: C.paper, border: C.mid, seed: seedFor(0, 0, w) }));
    // Category accent: a thin rule hugging the bottom edge, doubling as the
    // header/body divider. The only per-scene colour cue on an otherwise
    // uniform paper bar (see HEADER_ACCENT).
    const ruleH = Math.max(2, Math.round(headerH * 0.03));
    const rule = new PIXI.Graphics();
    rule.beginFill(accent);
    rule.drawRect(0, headerH - ruleH, w, ruleH);
    rule.endFill();
    c.addChild(rule);
  } else {
    const bar = new PIXI.Graphics();
    bar.beginFill(C.dark);
    bar.drawRect(0, 0, w, headerH);
    bar.endFill();
    c.addChild(bar);
  }

  const { chip, h: chipH } = buildBackChip(label, size, variant);
  chip.x = BACK_X;
  chip.y = (headerH - chipH) / 2;
  c.addChild(chip);

  return c;
}

/**
 * Draw the shared header into `container` and return its height + the back
 * button's hit rect. The chrome (dark bar + back glyph) is cached per
 * (orientation size, label); the title is drawn live (it differs per scene).
 *
 * @param title Already-translated scene title, or `null` when the scene draws
 *   its own title (e.g. a raised title above a subtitle) — only the bar +
 *   back glyph are rendered.
 * @param opts.headerH Override the bar height (rare; defaults to {@link sceneHeaderHeight}).
 *   The SLG/editor scenes pass their own fixed bar height here so their body
 *   layout (laid out below a fixed `HUD_H`/`HEADER_H` constant) stays put.
 * @param opts.titleSize Override the title font size (defaults to 3.4% of height).
 * @param opts.variant Bar styling — see {@link SceneHeaderVariant} (default 'paper').
 * @param opts.accent Category accent colour for the bottom rule (defaults to the
 *   blue lobby accent). Pass one of {@link HEADER_ACCENT}.
 */
export function drawSceneHeader(
  container: PIXI.Container, w: number, h: number, title: string | null,
  opts?: { headerH?: number; titleSize?: number; variant?: SceneHeaderVariant; accent?: number },
): SceneHeaderResult {
  const headerH = opts?.headerH ?? sceneHeaderHeight(h);
  const variant = opts?.variant ?? 'paper';
  const accent = opts?.accent ?? HEADER_ACCENT.lobby;
  const size = backSize(h);
  const label = `← ${t('common.back')}`; // "← " + back

  const chrome = getCachedDisplay(
    `hdr:${variant}:${accent}:${Math.round(w)}x${headerH}:${size}:${label}`,
    () => buildChrome(w, headerH, label, size, variant, accent),
    w, headerH,
  );
  container.addChild(chrome);

  if (title !== null) {
    const titleColor = variant === 'paper' ? C.dark : 0xffffff;
    const titleNode = txt(title, opts?.titleSize ?? Math.round(h * 0.034), titleColor, true);
    titleNode.anchor.set(0.5, 0.5);
    titleNode.x = w / 2;
    titleNode.y = headerH / 2;
    container.addChild(titleNode);
  }

  return { headerH, backRect: { x: 0, y: 0, w: BACK_HIT_W, h: headerH } };
}

/** Local origin of the floating back chip in design space — same 10px inset as the bar (§3.1). */
const FLOAT_MARGIN = 10;

export interface FloatingBackButtonResult {
  /** Back-button hit area to register with the scene's own hit testing. */
  backRect: Rect;
}

/**
 * Draw a standalone back-button chip at the top-left corner, for full-bleed
 * scenes (e.g. WorldMapScene) that have no title bar to embed it in. Same
 * pill styling and left inset as {@link drawSceneHeader}'s back chip, just
 * without a bar behind it — the chip itself carries enough contrast (opaque
 * paper fill) to read over arbitrary content.
 */
export function drawFloatingBackButton(container: PIXI.Container, h: number): FloatingBackButtonResult {
  const size = backSize(h);
  const label = `← ${t('common.back')}`;

  const { w: chipW, h: chipH } = backChipSize(label, size);

  const display = getCachedDisplay(
    `backfloat:${size}:${label}`,
    () => buildBackChip(label, size, 'floating').chip,
    chipW, chipH,
  );
  display.x = FLOAT_MARGIN;
  display.y = FLOAT_MARGIN;
  container.addChild(display);

  return { backRect: { x: FLOAT_MARGIN, y: FLOAT_MARGIN, w: chipW, h: chipH } };
}

export interface HeaderCurrencyChip {
  icon: IconKind;
  color: number;
  amount: number;
  /** Short name drawn between the icon and the amount (e.g. "碎屑") — without it, an icon + bare
   * number is unreadable to a player who hasn't memorized the material set. */
  label?: string;
}

/**
 * Right-aligned coin (+ optional material chips, + optional capacity readout) drawn
 * on top of an already-baked header bar so it reads as part of the title row instead
 * of a separate band underneath it (the two used to visually float apart — see the
 * "装备/卡背包" header-alignment fix). Draw into a per-render overlay layer added
 * *after* the cached header chrome, so the coin icon isn't hidden behind the bar.
 */
export function drawHeaderCurrency(
  container: PIXI.Container,
  w: number, headerH: number,
  coins: number,
  chips: readonly HeaderCurrencyChip[] = [],
  capacity?: { text: string; color: number },
  scale = 1,
): void {
  const midY = headerH / 2;
  const iconSize = Math.round(headerH * 0.32 * scale);
  const fontSize = Math.round(headerH * 0.26 * scale);
  const labelSize = Math.round(fontSize * 0.8);
  const capSize = Math.round(headerH * 0.2 * scale);
  const gap = Math.round(headerH * 0.28 * scale);

  const cluster = new PIXI.Container();
  let cx = 0;

  const addChip = (
    icon: IconKind, color: number, amount: number, label?: string,
    amountColor: number = C.dark, bold = false,
  ): void => {
    // 'coin' goes through the shared atlas-backed glyph so this reads identically to the shop's
    // balance icon; other currency chips (materials, etc.) keep the procedural buildIcon draw.
    const ic = icon === 'coin' ? buildCoinIcon(icon, iconSize, color) : buildIcon(icon, iconSize, color);
    ic.x = cx; ic.y = -iconSize / 2;
    cluster.addChild(ic);
    cx += iconSize + 4;
    if (label) {
      const lb = txt(label, labelSize, C.mid);
      lb.anchor.set(0, 0.5); lb.x = cx; lb.y = 0;
      cluster.addChild(lb);
      cx += lb.width + 4;
    }
    const lbl = txt(amount.toLocaleString(), fontSize, amountColor, bold);
    lbl.anchor.set(0, 0.5); lbl.x = cx; lbl.y = 0;
    cluster.addChild(lbl);
    cx += lbl.width + gap;
  };

  // Coin balance: gold bold number, no text label — the glyph is the unit. This is the single
  // coin readout shared by every scene (shop / gacha / battle pass / equipment / roster / …).
  addChip('coin', C.gold, coins, undefined, C.gold, true);
  for (const chip of chips) addChip(chip.icon, chip.color, chip.amount, chip.label);

  if (capacity) {
    const capLbl = txt(capacity.text, capSize, capacity.color);
    capLbl.anchor.set(0, 0.5); capLbl.x = cx; capLbl.y = 0;
    cluster.addChild(capLbl);
    cx += capLbl.width;
  } else {
    cx -= gap; // trim the trailing gap after the last chip
  }

  cluster.x = w - 10 - cx;
  cluster.y = midY;
  container.addChild(cluster);
}
