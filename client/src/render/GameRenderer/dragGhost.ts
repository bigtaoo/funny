// The card that follows the pointer while a hand card is dragged, and the translucent "this is what
// lands here" preview drawn on the board under it. Extracted from input.ts (form①, claudedocs/
// client-modules.md "单文件 500 行收敛"): pure builders plus one tiny sprite holder, no InputPanel
// state. Design: art-direction-map-ui.md §7.2.2.
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../pixiText';
import { ATTACK_LANES } from '@nw/engine/config';
import type { BuildingType, CardDefinition, UnitType } from '@nw/engine/types';
import { CardType } from '../../game';
import type { GameRendererCore } from './core';
import { boardUnitHeight } from '../unitSize';
import { BUILDING_SPRITE_SIZE, buildingTextureUrl } from '../BuildingView';
import { palette } from '../theme';
import { FS, fitFont } from '../fontScale';
import { containScale } from '../cardArt';

/** Drag ghost card size (design px). */
export const GHOST_W = 64;
export const GHOST_H = 84;

const CARD_BG     = 0xfaf6ee;
const CARD_BORDER = 0x333333;
/** Same blue the affordable hand-card cost badge uses (HandView/cellDraw.ts drawAfford). */
const COST_BG     = 0x2244aa;
const CORNER      = 13;

/** Ghost alpha while the pointer is not over a valid landing (the card is the only feedback). */
export const GHOST_ALPHA = 0.9;
/** Ghost alpha while the landing preview is up: the board under the finger is what matters now. */
export const GHOST_ALPHA_OVER_LANDING = 0.5;
/** Landing-preview alpha: clearly a preview, never mistaken for the real unit / building. */
export const LANDING_ALPHA = 0.55;

function typeColor(cardType: CardType): number {
  return cardType === CardType.Spell ? palette.inkRed
       : cardType === CardType.Unit  ? palette.inkBlue
       :                               palette.marker;
}

/**
 * The drag ghost: a small copy of the hand card — the card's own illustration with its cost badge
 * in the top-right, the same badge the hand card wears. A card whose art is not loaded (or has
 * none) falls back to its name, fitted to the card.
 */
export function buildDragGhost(
  cardType: CardType, label: string, cost: number, art: PIXI.Texture | null,
): PIXI.Container {
  const c = new PIXI.Container();
  const accent = typeColor(cardType);
  const parts: PIXI.DisplayObject[] = [];

  let ghostW = GHOST_W;
  if (art) {
    const sprite = new PIXI.Sprite(art);
    sprite.anchor.set(0.5);
    sprite.scale.set(containScale(art.width, art.height, GHOST_W - 8, GHOST_H - 10));
    sprite.y = 2;
    parts.push(sprite);
  } else {
    const nameText = makeText(label, { fontSize: FS.micro, fill: 0x222222, align: 'center' });
    // Fitted to the ghost: FS.micro is lifted to the legibility floor on small screens, where
    // "Meteor Strike" / "Shield Bearer" ran out of both sides of the 64-px card. Step the size down
    // the scale first; a name that still does not fit at the floor wraps at its space, and a single
    // word that is still too wide ("Infantry" at the floor) widens the card rather than being cut.
    const nameMaxW = GHOST_W - 8;
    nameText.style.fontSize = fitFont(FS.micro, nameText.width, nameMaxW);
    if (nameText.width > nameMaxW && label.includes(' ')) {
      nameText.style.wordWrap = true;
      nameText.style.wordWrapWidth = nameMaxW;
    }
    ghostW = Math.max(GHOST_W, Math.ceil(nameText.width) + 8);
    nameText.anchor.set(0.5, 0.5);
    nameText.y = 4;
    parts.push(nameText);
  }

  const x0 = -ghostW / 2;
  const y0 = -GHOST_H / 2;
  const frame = new PIXI.Graphics();
  frame.lineStyle(2, CARD_BORDER);
  frame.beginFill(CARD_BG, 0.95);
  frame.drawRoundedRect(x0, y0, ghostW, GHOST_H, 5);
  frame.endFill();
  frame.lineStyle(0);
  frame.beginFill(accent, 0.07);
  frame.drawRoundedRect(x0 + 2, y0 + 2, ghostW - 4, GHOST_H - 4, 4);
  frame.endFill();
  // Type dog-ear, top-left — the hand card's colour signature (art-direction §3.3).
  frame.beginFill(accent, 0.85);
  frame.moveTo(x0, y0).lineTo(x0 + CORNER, y0).lineTo(x0, y0 + CORNER).lineTo(x0, y0);
  frame.endFill();

  // The badge grows with the digit rather than the digit shrinking to the badge: FS.tiny is lifted to
  // the legibility floor on small screens, and a cost nobody can read defeats the badge.
  const costText = makeText(String(cost), { fontSize: FS.tiny, fill: 0xffffff, fontWeight: 'bold' });
  const badgeR = Math.max(10, Math.ceil(Math.max(costText.width, costText.height * 0.8) / 2) + 2);
  const badgeX = x0 + ghostW - badgeR - 2;
  const badgeY = y0 + badgeR + 2;
  const badge = new PIXI.Graphics();
  badge.lineStyle(1.5, 0xffffff, 0.9);
  badge.beginFill(COST_BG);
  badge.drawCircle(badgeX, badgeY, badgeR);
  badge.endFill();
  costText.anchor.set(0.5, 0.5);
  costText.position.set(badgeX, badgeY);

  c.addChild(frame, ...parts, badge, costText);
  c.alpha = GHOST_ALPHA;
  return c;
}

/**
 * Where (and as what) a drop of `card` at (col, row) would land, or null when the drop would be
 * rejected — the same checks InputPanel.commitCardPlay makes and, in the tutorial, the same aim
 * assist (snapped onto the guided lane). Units preview as their card art at the same on-board
 * height the spawned unit will have (unitSize.ts#boardUnitHeight); buildings as their board sprite
 * at its board size.
 */
export function landingSpot(
  core: GameRendererCore, card: CardDefinition, art: PIXI.Texture | null, col: number, row: number,
): { tex: PIXI.Texture; x: number; y: number; w: number; h: number } | null {
  if (core.tutorial) {
    const target = core.tutorial.snapCardPlay(card.id, col, row);
    if (!target) return null;
    col = target.col;
  }
  if (!(ATTACK_LANES as readonly number[]).includes(col)) return null;
  const board = core.engine.state.board;
  if (card.cardType === CardType.Unit && card.unitType !== undefined && art) {
    if (board.isCellOccupiedByUnit(col, core.localSpawnRow)) return null;
    const pos = core.layout.gridToScreen(col, core.localSpawnRow);
    const h = boardUnitHeight(card.unitType as UnitType, core.layout.cellSize);
    return { tex: art, x: pos.x, y: pos.y, w: h, h };
  }
  if (card.cardType === CardType.Building && card.buildingType !== undefined) {
    const buildRow = core.localBuildRow;
    if (board.hasBuildingAt(col, buildRow) || board.isNoBuild(col, buildRow)) return null;
    const pos = core.layout.gridToScreen(col, buildRow);
    const tex = PIXI.Texture.from(buildingTextureUrl(card.buildingType as BuildingType));
    return { tex, x: pos.x, y: pos.y, w: BUILDING_SPRITE_SIZE, h: BUILDING_SPRITE_SIZE };
  }
  return null;
}

/**
 * The translucent preview of what a drop would place: a sprite at the landing cell, sized like the
 * real thing. Spells need none — Meteor / Rockslide already paint their AoE (placementHighlights.ts),
 * Haste has no target.
 */
export class LandingPreview {
  readonly sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);

  constructor() {
    this.sprite.anchor.set(0.5);
    this.sprite.alpha = LANDING_ALPHA;
    this.sprite.visible = false;
  }

  /** Contain-fit `tex` in a `boxW × boxH` box centred on (x, y). */
  show(tex: PIXI.Texture, x: number, y: number, boxW: number, boxH: number): void {
    if (!tex.baseTexture.valid) { this.hide(); return; }
    this.sprite.texture = tex;
    this.sprite.scale.set(containScale(tex.width, tex.height, boxW, boxH));
    this.sprite.position.set(x, y);
    this.sprite.visible = true;
  }

  hide(): void {
    this.sprite.visible = false;
  }

  get visible(): boolean {
    return this.sprite.visible;
  }

  /** The texture is shared (PIXI.Texture.from cache) — only the sprite is ours. */
  destroy(): void {
    this.sprite.destroy();
  }
}
