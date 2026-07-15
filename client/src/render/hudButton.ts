/**
 * hudButton.ts — shared button-background styles for the in-battle HUD.
 *
 * The full-screen scenes (login/lobby/settings/…) already share one button
 * primitive (`sketchPanel` in sketchUi.ts). The in-battle HUD (HUDView,
 * ProfilePopup, NetStatusView, TutorialDirector) is a separate, performance-
 * sensitive overlay drawn with crisp flat-fill Graphics rather than the
 * hand-sketched pen border — but its buttons had each picked their own hex
 * literal (0x2c2c2a, 0xf0ece0, 0x3a6ea5, 0x999999, …) with no shared source,
 * which is why backgrounds looked random across scenes. This module is the
 * single place those five variants live; colours flow from {@link palette}
 * (theme.ts) so a re-skin is one edit.
 */
import * as PIXI from 'pixi.js-legacy';
import { palette } from './theme';

export type HudButtonVariant = 'primary' | 'accent' | 'secondary' | 'danger' | 'disabled';

interface HudButtonStyle {
  fill: number;
  border: number;
  borderWidth: number;
  /** Label / icon color that reads on this fill. */
  text: number;
}

const HUD_BUTTON_STYLES: Record<HudButtonVariant, HudButtonStyle> = {
  /** Main action (Resume, Upgrade, Close, Skip). */
  primary:   { fill: palette.pencil,  border: 0x333333,      borderWidth: 1, text: 0xffffff },
  /** Alt action of equal weight to primary, distinguished by hue (Refresh, tutorial Next). */
  accent:    { fill: palette.inkBlue, border: 0x333333,      borderWidth: 1, text: 0xffffff },
  /** Secondary / low-emphasis action (Exit to Lobby, Settings gear). */
  secondary: { fill: 0xf0ece0,        border: 0xaaaaaa,      borderWidth: 1, text: palette.pencil },
  /** Destructive / warning action (Block, Remove). */
  danger:    { fill: 0xf6eceb,        border: palette.inkRed, borderWidth: 2, text: palette.inkRed },
  /** Non-interactive state of primary/accent buttons. */
  disabled:  { fill: 0x999999,        border: 0x333333,      borderWidth: 1, text: 0xdddddd },
};

/**
 * Draws a flat-fill, rounded-rect button background into `g` at local origin
 * (0,0) — caller positions the container and adds the label on top.
 */
export function drawHudButton(
  g: PIXI.Graphics, w: number, h: number, variant: HudButtonVariant,
  opts: { radius?: number; fillAlpha?: number } = {},
): void {
  const s = HUD_BUTTON_STYLES[variant];
  g.beginFill(s.fill, opts.fillAlpha ?? 1);
  g.lineStyle(s.borderWidth, s.border);
  g.drawRoundedRect(0, 0, w, h, opts.radius ?? Math.round(h * 0.25));
  g.endFill();
}

/** Label color that reads on the given variant's fill. */
export function hudButtonText(variant: HudButtonVariant): number {
  return HUD_BUTTON_STYLES[variant].text;
}
