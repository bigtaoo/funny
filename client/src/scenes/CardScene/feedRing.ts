// The fusion ring itself — title, hint, the target portrait at the center with its level stars, and
// the 5 material slots orbiting it. Split out of feed.ts (2026-08-18, form ① per
// claudedocs/client-modules.md) to keep feed.ts under the 500-line convention once the target-intent
// state machine landed there; same "explicit params, no domain class" shape as ./feedList.ts.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { FACTION_COLOR } from '../../render/factionIcon';
import { cardInstanceArtUrl, getArtTexture } from '../../render/cardArt';
import { buildLevelStars } from '../../render/levelStars';
import type { Rect } from '../../layout/ILayout';
import type { CardInstance } from '../../game/meta/SaveData';
import { MAX_CARD_LEVEL, FUSION_MATERIAL_COUNT, type CardDef, type Faction } from '../../game/meta/cardDefs';
import type { FuseRingGeom } from './feedAnim';

/** Column box + scale the ring is laid out into. All lengths already multiplied by S by the caller. */
export interface RingBox {
  colX: number;
  colW: number;
  topY: number;
  headerBlockH: number;
  ringH: number;
  S: number;
}

/**
 * Draw the header + ring into `ml` and return the geometry ./feedAnim.ts's fusion animation replays
 * over. `slotIds[i]` is the card occupying material slot i (null = empty, drawn as a dimmed outline
 * — the "you are 3 of 5 there" signal the panel now always shows rather than hiding behind an
 * automatic target swap).
 */
export function drawHeaderAndRing(
  ml: PIXI.Container,
  target: CardInstance,
  def: CardDef,
  inv: Record<string, CardInstance>,
  slotIds: readonly (string | null)[],
  box: RingBox,
  artHooked: Set<string>,
  pushHit: (rect: Rect, action: () => void) => void,
  onUnassign: (slotIdx: number) => void,
  onArtLoaded: () => void,
): FuseRingGeom {
  const { colX, colW, topY, headerBlockH, ringH, S } = box;

  const titleLbl = txt(t('roster.fuseTitle'), snapFont(13 * S), C.dark, true);
  titleLbl.anchor.set(0.5, 0); titleLbl.x = colX + colW / 2; titleLbl.y = topY + 8 * S;
  ml.addChild(titleLbl);

  const hintLbl = txt(t('roster.fuseHint'), snapFont(9.5 * S), C.mid);
  hintLbl.style.wordWrap = true;
  hintLbl.style.wordWrapWidth = colW - 12 * S;
  hintLbl.style.align = 'center';
  hintLbl.anchor.set(0.5, 0); hintLbl.x = colX + colW / 2; hintLbl.y = topY + 24 * S;
  ml.addChild(hintLbl);

  const artUrlFor = (cardId: string | null): string | null => {
    if (!cardId) return null;
    const inst = inv[cardId];
    return inst ? cardInstanceArtUrl(inst) : null;
  };

  const drawPortrait = (
    cardId: string | null, cx: number, cy: number, r: number, faction: Faction | undefined,
  ): void => {
    const frame = new PIXI.Graphics();
    frame.lineStyle(2, faction ? FACTION_COLOR[faction] : C.mid, cardId ? 1 : 0.4);
    frame.beginFill(0xf0eee7, cardId ? 1 : 0.5).drawCircle(cx, cy, r).endFill();
    ml.addChild(frame);
    if (!cardId) return;
    const artUrl = artUrlFor(cardId);
    if (!artUrl) return;
    const tex = getArtTexture(artUrl);
    if (tex.baseTexture.valid) {
      const scale = Math.min((r * 2 - 4) / tex.width, (r * 2 - 4) / tex.height);
      const sp = new PIXI.Sprite(tex);
      sp.anchor.set(0.5);
      sp.scale.set(scale);
      sp.position.set(cx, cy);
      ml.addChild(sp);
    } else if (!artHooked.has(artUrl)) {
      artHooked.add(artUrl);
      tex.baseTexture.once('loaded', onArtLoaded);
    }
  };

  const ringCx = colX + colW / 2;
  const ringCy = topY + headerBlockH + ringH / 2;
  const centerR = 22 * S;
  const slotR = 15 * S;
  const orbit = 46 * S;

  // Connecting spokes (drawn under the portraits) so the ring reads as one fusion unit.
  for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / FUSION_MATERIAL_COUNT;
    const sx = ringCx + Math.cos(ang) * orbit, sy = ringCy + Math.sin(ang) * orbit;
    const spoke = new PIXI.Graphics();
    spoke.lineStyle(1.5, C.mid, slotIds[i] ? 0.7 : 0.3);
    spoke.moveTo(ringCx, ringCy).lineTo(sx, sy);
    ml.addChild(spoke);
  }

  drawPortrait(target.id, ringCx, ringCy, centerR, def.faction);
  // Level as a row of gold stars, not "Lv.N" text (2026-07-25) — matches the roster grid (list.ts) /
  // detail modal (detail.ts) convention: one filled star per level, capped at MAX_CARD_LEVEL. No maxW
  // cap here (nothing to shrink to fit against) — just centered on width.
  const starN = Math.max(1, Math.min(MAX_CARD_LEVEL, target.level));
  const { container: stars } = buildLevelStars(starN, Infinity, 8 * S, 2 * S);
  stars.name = 'levelStars';
  stars.x = ringCx - stars.width / 2; stars.y = ringCy + centerR + 2 * S;
  ml.addChild(stars);

  const slotPositions: { x: number; y: number }[] = [];
  const slotArtUrl: (string | null)[] = [];
  for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / FUSION_MATERIAL_COUNT;
    const sx = ringCx + Math.cos(ang) * orbit, sy = ringCy + Math.sin(ang) * orbit;
    slotPositions.push({ x: sx, y: sy });
    const slotCardId = slotIds[i];
    slotArtUrl.push(artUrlFor(slotCardId));
    drawPortrait(slotCardId, sx, sy, slotR, def.faction);
    if (slotCardId) {
      pushHit({ x: sx - slotR, y: sy - slotR, w: slotR * 2, h: slotR * 2 }, () => onUnassign(i));
    }
  }
  return {
    center: { x: ringCx, y: ringCy }, slots: slotPositions, color: FACTION_COLOR[def.faction],
    centerR, slotR, slotArtUrl, targetArtUrl: artUrlFor(target.id),
  };
}
