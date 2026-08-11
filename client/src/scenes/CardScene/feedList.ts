// Fuse candidate-list row renderer, split out of feed.ts (2026-08-11, form ① independent function
// module per claudedocs/client-modules.md's split-form priority note) purely to keep feed.ts under
// the 500-line convention — FamilyScene/SectScene's lists.ts precedent. Takes every piece of
// drawFusePanel's local per-open state it needs (artHooked / the pick + hit-push callbacks) as
// explicit params rather than becoming its own domain class, since none of it is shared beyond one
// row's draw call.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { FACTION_COLOR } from '../../render/factionIcon';
import { cardInstanceArtUrl, getArtTexture } from '../../render/cardArt';
import type { Rect } from '../../layout/ILayout';
import { CARD_DEFS } from '../../game/meta/cardDefs';
import type { CardSceneCore } from './core';

/** One collapsed candidate row: all owned same-level same-faction cards of one defId. */
export interface FuseGroup {
  defId: string;
  ids: string[];
}

/**
 * Draw one candidate row (thumbnail + name + owned count) into `listC` at `rowTop`, and register its
 * tap hit (clipped to the scroll viewport by the caller-supplied `pushHit`) when a slot is free.
 * `onArtLoaded` re-triggers the panel redraw once a not-yet-loaded thumbnail texture streams in —
 * callers pass `() => core.feedRedraw?.()` so this stays decoupled from the panel's own redraw
 * closure.
 */
export function drawFuseCandidateRow(
  core: CardSceneCore,
  listC: PIXI.Container,
  g: FuseGroup,
  i: number,
  listX: number,
  rowTop: number,
  rowW: number,
  rowH: number,
  S: number,
  artHooked: Set<string>,
  canAssign: boolean,
  pushHit: (rect: Rect, action: () => void) => void,
  onPick: () => void,
  onArtLoaded: () => void,
): void {
  const gDef = CARD_DEFS[g.defId];

  const rowBg = sketchPanel(rowW, rowH - 4 * S, { fill: canAssign ? 0xf5f3ec : 0xeeeeee, border: C.mid, seed: seedFor(i, 19, rowW) });
  rowBg.x = listX; rowBg.y = rowTop;
  listC.addChild(rowBg);

  const thumbBox = rowH - 8 * S;
  const thumbX = listX + 4 * S;
  const thumbY = rowTop + (rowH - thumbBox) / 2;
  if (gDef) {
    const frame = sketchPanel(thumbBox, thumbBox, { fill: 0xf0eee7, border: FACTION_COLOR[gDef.faction], seed: seedFor(i, 24, thumbBox) });
    frame.x = thumbX; frame.y = thumbY;
    listC.addChild(frame);
    const artUrl = cardInstanceArtUrl({ defId: g.defId });
    if (artUrl) {
      const tex = getArtTexture(artUrl);
      if (tex.baseTexture.valid) {
        const scale = Math.min((thumbBox - 4 * S) / tex.width, (thumbBox - 4 * S) / tex.height);
        const sp = new PIXI.Sprite(tex);
        sp.anchor.set(0.5);
        sp.scale.set(scale);
        sp.position.set(thumbX + thumbBox / 2, thumbY + thumbBox / 2);
        listC.addChild(sp);
      } else if (!artHooked.has(artUrl)) {
        artHooked.add(artUrl);
        tex.baseTexture.once('loaded', onArtLoaded);
      }
    }
  }

  // Level suffix dropped (2026-07-25): every row already matches the target's current level
  // (fusionMaterialCandidates enforces it), and the level itself now shows once as stars on
  // the ring target above — restating "Lv.N" per row was redundant.
  const matName = t(`card.${g.defId}.name` as TranslationKey);
  const nameLbl = txt(matName, snapFont(11 * S), C.dark, true);
  nameLbl.anchor.set(0, 0.5); nameLbl.x = thumbX + thumbBox + 8 * S; nameLbl.y = rowTop + rowH / 2;
  listC.addChild(nameLbl);

  const countLbl = txt(`x${g.ids.length}`, snapFont(11 * S), C.mid);
  countLbl.anchor.set(1, 0.5); countLbl.x = listX + rowW - 8 * S; countLbl.y = rowTop + rowH / 2;
  listC.addChild(countLbl);

  if (canAssign) pushHit({ x: listX, y: rowTop, w: rowW, h: rowH - 4 * S }, onPick);
}
