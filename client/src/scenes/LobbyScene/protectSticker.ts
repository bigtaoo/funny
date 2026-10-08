// "N games today without ELO loss" sticker on the hero START MATCH button (SEASON_DESIGN_IMPL_SPEC.md
// §15.5): how many ranked games the player can still lose today for free (new-player slots left + daily
// slots left). Its own module so the hero layout in mainContent.ts only gains one call.
//
// Placement: a small paper tag straddling the hero's top edge at its right end, like a sticker slapped
// on the button — it spends the margin between header and hero (≥ 3.5% of h, see mainContent's
// `startY`) instead of any of the hero's own interior, so the START MATCH label and the "Ranked · …"
// sub line keep exactly the room they had. Taps fall through to the hero (hit-testing is by
// `core.btnRect`), which is what a tap on it should do anyway.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { FS } from '../../render/fontScale';
import type { Rect } from '../../layout/ILayout';
import { C, txt, sketchPanel, type LobbySceneCore } from './core';

/** Draws the sticker when `left` > 0; records its rect on `core.protectStickerRect` (null when hidden). */
export function drawProtectSticker(core: LobbySceneCore, hero: Rect, headerBottom: number, left: number): void {
  core.protectStickerRect = null;
  if (!(left > 0)) return;
  const label = txt(t(left === 1 ? 'lobby.protectLeftOne' : 'lobby.protectLeft', { n: left }), FS.body, C.dark, true);
  const padX = Math.round(label.height * 0.55);
  const padY = Math.round(label.height * 0.15);
  // At most ~60% of the hero's width, right-aligned: the centred START MATCH label owns the middle.
  const maxLabelW = hero.w * 0.6 - 2 * padX;
  if (label.width > maxLabelW) label.scale.set(maxLabelW / label.width);
  const pw = Math.round(label.width + 2 * padX);
  const ph = Math.round(label.height + 2 * padY);
  const x = Math.round(hero.x + hero.w - pw - hero.h * 0.08);
  // Centred on the hero's top edge, but never up into the header band.
  const y = Math.max(Math.round(headerBottom + 2), Math.round(hero.y - ph / 2));

  const layer = new PIXI.Container();
  layer.name = 'lobby:protectSticker';
  const bg = sketchPanel(pw, ph, { fill: C.paper, border: C.green, width: 1.6, seed: 57 });
  layer.addChild(bg);
  label.anchor.set(0.5, 0.5);
  label.x = pw / 2;
  label.y = ph / 2;
  layer.addChild(label);
  layer.x = x;
  layer.y = y;
  core.container.addChild(layer);
  core.protectStickerRect = { x, y, w: pw, h: ph };
}
