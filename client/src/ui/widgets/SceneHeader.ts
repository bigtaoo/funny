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
 *   - label    : a drawn back-arrow glyph + t('common.back'), both in the blue affordance accent
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
import { buildIcon, tabIconVariant, type IconKind } from '../../render/icons';
import { buildCoinIcon } from '../../render/atlas/coinIconAtlas';
import { FS, snapFont } from '../../render/fontScale';
import { drawGuilloche } from './SceneHeader/guilloche';

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

/**
 * Back-glyph (and default title) font size — kept in one place so every scene's
 * back/title reads alike. Scales with the bar's own actual `headerH` above a flat
 * `FS.headline` floor, instead of the flat token alone: `PortraitLayout` stretches
 * design height (and therefore `sceneHeaderHeight`) on tall/notched phones so the
 * bar keeps a constant ~12% of screen height, but the old flat-token size didn't
 * grow with it — on a tall portrait bar (~98px real on a 375×812 screen) the text
 * stayed pinned at ~15px, reading as "the header is too small" when the bar itself
 * had plenty of headroom going unused. `HEADER_CONTENT_RATIO` is tuned so a
 * landscape/compact bar (`headerH` design ≈130) computes below the floor and falls
 * back to the unchanged `FS.headline` size — only bars taller than that actually grow.
 * Approved 11.08.2026 (portrait top-bar content-too-small fix).
 */
const HEADER_CONTENT_RATIO = 0.30;
function backSize(headerH: number): number {
  return Math.max(FS.headline, Math.round(headerH * HEADER_CONTENT_RATIO)); // 1.5x the original 0.026 — approved 12.07.2026 back-button enlargement.
}

/**
 * Title-icon box size and its gap to the title, both as a multiple of the title font size —
 * so the glyph tracks `backSize`'s portrait scale-up along with the text instead of needing a
 * second height-derived formula. 1.25 puts the box a bit above cap height (a 32px title gets a
 * 40px box), which is what makes a line-art glyph read as the same visual weight as bold text
 * rather than as a subscript next to it.
 */
const TITLE_ICON_RATIO = 1.25;
const TITLE_ICON_GAP_RATIO = 0.34;

/**
 * Share of the bar width held back on the right for the currency cluster scenes draw on top of the
 * header (see {@link drawHeaderCurrency}): a coin glyph plus a 3–7 digit amount. Deliberately a
 * fixed reserve rather than plumbing the real cluster width through every caller — the cluster is
 * drawn after this returns, by the scene, and a title that stops a little early costs nothing while
 * one that runs under the coin readout is unreadable.
 */
const TITLE_RIGHT_RESERVE_RATIO = 0.2;

/**
 * The scene-title glyph — the missing counterpart to `HubTab.icon` (see `HubTabs.ts`). Before
 * this, tab strips could carry an icon but the title bar every secondary scene draws could not,
 * so a page's own name was the one nav-level label in the app with no picture attached.
 *
 * Ink: raster tab icons are baked per-ink at pack time and can't be tinted live (`icons.ts`), and
 * `tabIconVariant` can only tell "light ink" from "dark ink" — it never returns `'content'` on its
 * own. A paper bar's dark title wants exactly that third ink (`C.dark`, the same as the title text)
 * rather than the deliberately de-emphasised grey baked for *inactive tabs*, so this asks for it
 * explicitly, the same way `buildRewardIcon` does for reward rows. The legacy `'dark'` bar variant
 * (white title) still resolves to the white `active` art.
 *
 * Exported because three scenes pass `title: null` and draw their own title inside the bar
 * (CampaignMapScene's chapter title + owner subtitle, FamilyScene/SectScene's org identity) —
 * they lay the group out themselves but must not re-derive the ink rule: `size`/`gap` are
 * returned so a caller can centre `[icon][gap][title]` exactly like {@link drawSceneHeader} does.
 */
export function buildTitleIcon(
  kind: IconKind, titleSize: number, titleColor: number,
): { node: PIXI.DisplayObject; size: number; gap: number } {
  const size = Math.round(titleSize * TITLE_ICON_RATIO);
  const variant = tabIconVariant(titleColor) === 'active' ? 'active' : 'content';
  return {
    node: buildIcon(kind, size, titleColor, { variant }),
    size,
    gap: Math.round(titleSize * TITLE_ICON_GAP_RATIO),
  };
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

/**
 * Back-arrow glyph box and its gap to the label, as a multiple of the label size — the same
 * [icon][gap][text] shape {@link buildTitleIcon} gives the title, one notch smaller (1.0 vs 1.25)
 * because the arrow is a lead-in, not the subject of the chip.
 */
const BACK_ARROW_RATIO = 1.0;
const BACK_ARROW_GAP_RATIO = 0.22;

/** Chip padding + overall (w,h) around the back arrow + label — shared by the builder and callers that need the size before a cache-miss draw runs. */
function backChipSize(label: string, size: number): { padX: number; padY: number; arrow: number; gap: number; w: number; h: number } {
  const { w: labelW, h: labelH } = measureBackLabel(label, size);
  const padX = Math.round(size * 0.7);
  const padY = Math.round(size * 0.5);
  const arrow = Math.round(size * BACK_ARROW_RATIO);
  const gap = Math.round(size * BACK_ARROW_GAP_RATIO);
  return { padX, padY, arrow, gap, w: arrow + gap + labelW + padX * 2, h: labelH + padY * 2 };
}

/**
 * Where a scene may start drawing its own header content: the right edge of the back pill plus a
 * gap. FamilyScene/SectScene draw their own title cluster into the bar (they pass `title: null`)
 * and used to re-derive the pill width from a copy of the chip formula — which silently went stale
 * the moment the chip grew an arrow glyph (19.08.2026).
 */
export function backPillRightEdge(h: number): number {
  const size = backSize(sceneHeaderHeight(h));
  return BACK_X + backChipSize(t('common.back'), size).w + Math.round(size * 0.6);
}

/**
 * Build the back-button "pill": a lightweight rounded-rect chip behind the
 * label so the tap target reads as a button rather than bare text floating
 * on the bar (see the 05.07.2026 back-button unification pass). Deliberately
 * *not* the hand-drawn `sketchPanel` border used for real buttons elsewhere
 * (§7.5) — this is a subtle underlay, not a primary action button.
 */
function buildBackChip(label: string, size: number, ctx: BackChipContext): { chip: PIXI.Container; w: number; h: number } {
  const { padX, arrow, gap, w, h } = backChipSize(label, size);

  const chip = new PIXI.Container();
  const bg = new PIXI.Graphics();
  const [fill, alpha] = ctx === 'paper' ? [C.dark, 0.08] : ctx === 'floating' ? [C.paper, 0.92] : [0xffffff, 0.12];
  bg.beginFill(fill, alpha);
  bg.drawRoundedRect(0, 0, w, h, Math.round(h * 0.32));
  bg.endFill();
  chip.addChild(bg);

  // Hand-drawn arrow in the same accent ink as the label (see `backArrow` in render/icons) — the
  // literal "←" it replaces was the one glyph in the bar the sketch pen never touched.
  const ar = buildIcon('backArrow', arrow, C.accent);
  ar.x = padX;
  ar.y = Math.round(h / 2 - arrow / 2);
  chip.addChild(ar);

  const lbl = txt(label, size, C.accent);
  lbl.anchor.set(0, 0.5);
  lbl.x = padX + arrow + gap;
  lbl.y = h / 2;
  chip.addChild(lbl);

  return { chip, w, h };
}

/** Build the static bar chrome (fill + guilloche + accent rule + back chip) at local origin. */
function buildChrome(
  w: number, headerH: number, label: string, size: number, variant: SceneHeaderVariant, accent: number,
): PIXI.Container {
  const c = new PIXI.Container();

  if (variant === 'paper') {
    c.addChild(sketchPanel(w, headerH, { fill: C.paper, border: C.mid, seed: seedFor(0, 0, w) }));
    // Faint banknote guilloche watermark over the paper fill, tinted in the
    // category accent — a premium texture that reads under the title/back/coins.
    const weave = new PIXI.Graphics();
    drawGuilloche(weave, w, headerH, accent);
    c.addChild(weave);
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
 * @param opts.headerH Override the bar height (defaults to {@link sceneHeaderHeight}).
 *   Retained as API but **no scene ships an override** as of the 07–08.07.2026
 *   header-height-unification pass — every secondary scene uses the default so the
 *   title row reads at one height app-wide (each lays its body out below the returned
 *   `hdr.headerH`, no longer a per-scene fixed `HUD_H`/`HEADER_H` constant).
 * @param opts.titleSize Override the title font size (defaults to 3.4% of height).
 * @param opts.variant Bar styling — see {@link SceneHeaderVariant} (default 'paper').
 * @param opts.accent Category accent colour for the bottom rule (defaults to the
 *   blue lobby accent). Pass one of {@link HEADER_ACCENT}.
 * @param opts.titleAlign 'center' (default) or 'left'. Left-aligns the title just
 *   right of the back pill — use it on scenes that also draw a wide right-side
 *   currency cluster (equipment/roster), where a centred title would collide with
 *   it on the narrow portrait bar.
 * @param opts.icon Glyph drawn left of the title as one centred/left-aligned group —
 *   see {@link buildTitleIcon}. Scenes whose concept already has an AI tab icon should
 *   pass that same kind, so the page's title and the tab that navigates to it read as
 *   the same thing.
 */
export function drawSceneHeader(
  container: PIXI.Container, w: number, h: number, title: string | null,
  opts?: {
    headerH?: number; titleSize?: number; variant?: SceneHeaderVariant; accent?: number;
    titleAlign?: 'center' | 'left'; icon?: IconKind;
  },
): SceneHeaderResult {
  const headerH = opts?.headerH ?? sceneHeaderHeight(h);
  const variant = opts?.variant ?? 'paper';
  const accent = opts?.accent ?? HEADER_ACCENT.lobby;
  const size = backSize(headerH);
  const label = t('common.back'); // the arrow is a drawn glyph now, see buildBackChip

  const chrome = getCachedDisplay(
    `hdr:${variant}:${accent}:${Math.round(w)}x${headerH}:${size}:${label}`,
    () => buildChrome(w, headerH, label, size, variant, accent),
    w, headerH,
  );
  container.addChild(chrome);

  if (title !== null) {
    const titleColor = variant === 'paper' ? C.dark : 0xffffff;
    const titleSize = opts?.titleSize ?? size;
    const titleNode = txt(title, titleSize, titleColor, true);
    const icon = opts?.icon ? buildTitleIcon(opts.icon, titleSize, titleColor) : null;
    // Both alignments position the [icon][gap][title] group by its LEFT edge, so the icon pushes
    // the title right instead of overlapping it. With no icon and room to spare, the centred case
    // is pixel-identical to the old `anchor 0.5 at w/2` (leadW = 0, fit = 1).
    //
    // The band the group may occupy: right of the back pill, and short of the right edge by enough
    // for the currency readout scenes draw over the bar (drawHeaderCurrency). Both ends bite on a
    // narrow portrait bar, where the back pill alone eats a third of the width — the first in-game
    // capture of this pass had the icon painted across the back label, and clamping it right then
    // pushed "Hero Roster" off the right edge.
    const afterBackPill = BACK_X + backChipSize(label, size).w + Math.round(size * 0.6);
    const bandW = w - afterBackPill - Math.round(w * TITLE_RIGHT_RESERVE_RATIO);
    // Shrink icon and text together rather than dropping the icon or letting either clip — the
    // same "scale a label down to fit its cell" rule the tab strips already use (HubTabs.ts).
    // Only long labels on a narrow bar ever scale; CJK titles are 3–4 glyphs and fit outright.
    const fullW = (icon ? icon.size + icon.gap : 0) + titleNode.width;
    const fit = bandW > 0 && fullW > bandW ? bandW / fullW : 1;
    if (fit < 1) titleNode.scale.set(fit);
    const leadW = icon ? Math.round((icon.size + icon.gap) * fit) : 0;
    const groupX = opts?.titleAlign === 'left'
      // Sit just right of the back pill so a right-aligned currency cluster has room.
      ? afterBackPill
      : Math.max(afterBackPill, Math.round((w - (leadW + titleNode.width)) / 2));
    if (icon) {
      icon.node.scale.set(fit);
      icon.node.x = groupX;
      icon.node.y = Math.round(headerH / 2 - (icon.size * fit) / 2);
      container.addChild(icon.node);
    }
    titleNode.anchor.set(0, 0.5);
    titleNode.x = groupX + leadW;
    titleNode.y = headerH / 2;
    container.addChild(titleNode);
  }

  // Hit/geometry width: at least the comfortable BACK_HIT_W tap target, but never smaller
  // than the chip actually drawn — on a tall portrait bar (backSize scales with headerH,
  // 11.08.2026) the chip can render wider than the old flat 160. Callers elsewhere (e.g.
  // WorldMapPanels/hud.ts's resource-cluster leftBound) treat this as "where the back
  // button ends" to avoid drawing over it; a too-small reported width let the resource
  // cluster's opaque background paint over the tail of the back label ("← Bac[k]" bug,
  // same-day regression from the backSize portrait scale-up).
  const chipW = backChipSize(label, size).w;
  return { headerH, backRect: { x: 0, y: 0, w: Math.max(BACK_HIT_W, chipW), h: headerH } };
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
  // No real bar here (full-bleed scene), so size off the notional bar height a
  // regular header would have used at this screen height — keeps this chip
  // matching drawSceneHeader's back-button size on the same device.
  const size = backSize(sceneHeaderHeight(h));
  const label = t('common.back');

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
  /** Short name drawn between the icon and the amount (e.g. "crumbs") — without it, an icon + bare
   * number is unreadable to a player who hasn't memorized the material set. */
  label?: string;
}

/**
 * Right-aligned coin (+ optional material chips, + optional capacity readout) drawn
 * on top of an already-baked header bar so it reads as part of the title row instead
 * of a separate band underneath it (the two used to visually float apart — see the
 * "equipment/card inventory" header-alignment fix). Draw into a per-render overlay layer added
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
  const fontSize = snapFont(Math.round(headerH * 0.26 * scale));
  const labelSize = snapFont(Math.round(fontSize * 0.8));
  const capSize = snapFont(Math.round(headerH * 0.2 * scale));
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
