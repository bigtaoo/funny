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

/**
 * Bar styling:
 *   - 'dark'  : solid dark fill, white title — the default for lobby-side menu
 *               scenes (Achievement, Shop, Gacha, …).
 *   - 'paper' : hand-drawn paper panel (paper fill + mid sketch border), dark
 *               title — matches the SLG / editor scenes (World, Family, Sect,
 *               Auction, Equipment, Teams, DefenseEditor) whose bodies sit on
 *               the paper background. The right side of the bar is left free, so
 *               callers may draw their own controls (e.g. a level stepper) on
 *               top of the baked chrome after this returns.
 */
export type SceneHeaderVariant = 'dark' | 'paper';

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

/** Build the static bar chrome (fill + back glyph) at local origin. */
function buildChrome(
  w: number, headerH: number, label: string, size: number, variant: SceneHeaderVariant,
): PIXI.Container {
  const c = new PIXI.Container();

  if (variant === 'paper') {
    c.addChild(sketchPanel(w, headerH, { fill: C.paper, border: C.mid, seed: seedFor(0, 0, w) }));
  } else {
    const bar = new PIXI.Graphics();
    bar.beginFill(C.dark);
    bar.drawRect(0, 0, w, headerH);
    bar.endFill();
    c.addChild(bar);
  }

  const back = txt(label, size, C.accent);
  back.anchor.set(0, 0.5);
  back.x = BACK_X;
  back.y = headerH / 2;
  c.addChild(back);

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
 * @param opts.variant Bar styling — see {@link SceneHeaderVariant} (default 'dark').
 */
export function drawSceneHeader(
  container: PIXI.Container, w: number, h: number, title: string | null,
  opts?: { headerH?: number; titleSize?: number; variant?: SceneHeaderVariant },
): SceneHeaderResult {
  const headerH = opts?.headerH ?? sceneHeaderHeight(h);
  const variant = opts?.variant ?? 'dark';
  const size = backSize(h);
  const label = `← ${t('common.back')}`; // "← " + back

  const chrome = getCachedDisplay(
    `hdr:${variant}:${Math.round(w)}x${headerH}:${size}:${label}`,
    () => buildChrome(w, headerH, label, size, variant),
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
