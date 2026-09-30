import * as PIXI from 'pixi.js-legacy';
import { snapFont, currentFontFloor } from '../../render/fontScale';
import { measuredWidth } from '../../render/pixiText';
import { fitToWidth } from '../../ui/widgets/truncateText';

// Row geometry and name fitting for LeaderboardScene, split out as pure functions (testable
// without a renderer). LeaderboardScene.ts re-exports them, so import paths are unchanged.

/**
 * Row column geometry, split out as a pure function so it can be tested without a renderer.
 *
 * Why this exists (2026-08-16, TITLE_DESIGN §6 note): the row used to derive its **font sizes**
 * from `rowH` (which tracks screen *height*) while placing its **columns** at fractions of `w`
 * (screen *width*). Landscape is ~16:9 so nothing showed; portrait is ~1:2, so the height-driven
 * type ran far wider than the width-driven grid — measured against real `monospace` metrics, a row
 * with the default `Player1234` name and any equipped title pushed the title label 58px (zh) to
 * 182px (de `Rangliste`) into the rank-tier column, in every locale, on every portrait phone, and
 * worse on taller ones.
 *
 * Portrait now gives each row two lines (name on top; title / tier / ELO beneath), which is what
 * actually buys the space back. The single-line landscape form is unchanged. Both paths hand the
 * name+title block a hard right boundary and clamp into it via {@link fitNameAndTitle}, so an
 * unusually long display name cannot reintroduce the collision — worth having, since no
 * server-side length cap on `displayName` was found.
 */
export interface RowGeom {
  twoLine: boolean;
  rankX: number; rankCY: number; rankFs: number; medalSize: number;
  nameX: number; nameCY: number; nameFs: number;
  titleCY: number; titleFs: number;
  /** Right boundary the name+title block must not cross (the tier column's left edge). */
  contentRight: number;
  tierCX: number; tierCY: number; tierFs: number;
  eloRightX: number; eloCY: number; eloFs: number;
}

export function leaderboardRowGeom(w: number, rowH: number, twoLine: boolean): RowGeom {
  const rankX = Math.round(w * 0.03);
  const nameX = Math.round(w * 0.18);
  const eloRightX = w - Math.round(w * 0.03);

  if (!twoLine) {
    const tierFs = snapFont(Math.round(rowH * 0.38));
    const tierCX = w * 0.68;
    return {
      twoLine: false,
      rankX, rankCY: rowH / 2, rankFs: snapFont(Math.round(rowH * 0.5)), medalSize: Math.round(rowH * 0.62),
      nameX, nameCY: rowH / 2, nameFs: snapFont(Math.round(rowH * 0.48)),
      titleCY: rowH / 2, titleFs: snapFont(Math.round(rowH * 0.3)),
      // Half a tier label of clearance: the tier text is centre-anchored on tierCX.
      contentRight: tierCX - tierFs,
      tierCX, tierCY: rowH / 2, tierFs,
      eloRightX, eloCY: rowH / 2, eloFs: snapFont(Math.round(rowH * 0.5)),
    };
  }

  // Portrait: line 1 carries the name, line 2 the title / tier / ELO. Type is sized off rowH as
  // before, but from the *line* share of it rather than the whole row, so the fonts stay in the
  // same visual ballpark as the old single-line row instead of doubling with the height.
  const line1CY = rowH * 0.34;
  const line2CY = rowH * 0.74;
  const tierFs = snapFont(Math.round(rowH * 0.16));
  const tierCX = w * 0.62;
  return {
    twoLine: true,
    rankX, rankCY: rowH / 2, rankFs: snapFont(Math.round(rowH * 0.26)), medalSize: Math.round(rowH * 0.42),
    nameX, nameCY: line1CY, nameFs: snapFont(Math.round(rowH * 0.23)),
    titleCY: line2CY, titleFs: snapFont(Math.round(rowH * 0.16)),
    contentRight: tierCX - tierFs,
    tierCX, tierCY: line2CY, tierFs,
    eloRightX, eloCY: line2CY, eloFs: snapFont(Math.round(rowH * 0.22)),
  };
}

/**
 * Fit a measured name and title into `avail` px, returning the scale to apply to each and where
 * the title starts. Takes measured widths rather than strings so it stays renderer-free.
 *
 * When both fit, nothing is scaled — the common case must be pixel-identical to no clamping at
 * all. When they do not, the title is capped at a minority share of the space (the name is the
 * identifying field and gets the remainder) and each is scaled down to its budget, the same
 * shrink-to-fit TitlesScene already uses for its own overlong labels.
 */
export function fitNameAndTitle(
  nameW: number, titleW: number, avail: number, gap: number,
): { nameScale: number; titleScale: number; titleX: number } {
  if (nameW + gap + titleW <= avail) {
    return { nameScale: 1, titleScale: 1, titleX: nameW + gap };
  }
  const titleBudget = Math.max(0, Math.min(titleW, avail * 0.45));
  const nameBudget = Math.max(0, avail - gap - titleBudget);
  const nameScale = nameW > 0 ? Math.min(1, nameBudget / nameW) : 1;
  const titleScale = titleW > 0 ? Math.min(1, titleBudget / titleW) : 1;
  return { nameScale, titleScale, titleX: nameW * nameScale + gap };
}

/**
 * How far a row's player name may shrink before the rest of it is cut instead — the lobby header's
 * rule (LobbyScene/header.ts NAME_MIN_SCALE), and never under the legibility floor. Names run to
 * 24 characters, all of them CJK if the player likes: at 20+ such characters the old
 * `scale.set(avail / width)` took a row name to ~16 design px, under the floor of 20 (2026-09-29).
 * The full name is one tap away, on the profile.
 */
const NAME_MIN_SCALE = 0.8;

/** Fit `lbl` (showing `full` at `size`) into `maxW`: shrink to {@link NAME_MIN_SCALE}, then cut with "…". */
export function fitRowName(lbl: PIXI.Text, full: string, size: number, maxW: number): void {
  lbl.text = full;
  lbl.scale.set(1);
  const fullW = measuredWidth(lbl);
  if (fullW <= maxW) return;
  const minScale = Math.min(1, Math.max(NAME_MIN_SCALE, currentFontFloor() / size));
  const scale = maxW / fullW;
  if (scale >= minScale) { lbl.scale.set(scale); return; }
  lbl.text = fitToWidth(full, size, maxW / minScale);
  lbl.scale.set(minScale);
}

