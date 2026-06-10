import * as PIXI from 'pixi.js-legacy';
import { Player } from '../game/Player';
import { CardDefinition, CardType, UnitType, BuildingType } from '../game/types';
import { ILayout } from '../layout/ILayout';
import { ObjectPool } from '../cache/ObjectPool';
import { t } from '../i18n';
import infantryArtUrl from '../assets/infantry.png';
import archerArtUrl from '../assets/archer.png';
import shieldBearerArtUrl from '../assets/shield_bearer.png';
import barracksArtUrl from '../assets/game_infantry_barracks.png';
import towerArtUrl from '../assets/game_archer_barracks.png';

const CARD_BG              = 0xfaf6ee;
const CARD_BORDER          = 0x333333;
const CARD_SELECTED_BORDER = 0xffcc00;
const CARD_LIFT            = 14;
const ERASER_COLOR         = 0xf0ece0;
const ERASER_ALPHA         = 0.62;

// 卡牌插画：单位/建筑卡显示对应图片，法术卡无图（仅文字）
const CARD_ART_URLS: Record<string, string> = {
  [`unit_${UnitType.Swordsman}`]:        infantryArtUrl as string,
  [`unit_${UnitType.Archer}`]:           archerArtUrl as string,
  [`unit_${UnitType.Guardian}`]:         shieldBearerArtUrl as string,
  [`building_${BuildingType.Barracks}`]: barracksArtUrl as string,
  [`building_${BuildingType.ArrowTower}`]: towerArtUrl as string,
};

function cardArtKey(card: CardDefinition): string | null {
  if (card.cardType === CardType.Unit && card.unitType !== undefined) {
    return `unit_${card.unitType}`;
  }
  if (card.cardType === CardType.Building && card.buildingType !== undefined) {
    return `building_${card.buildingType}`;
  }
  return null;
}

// ── Card slot structure ────────────────────────────────────────────────────────
//
// Children by name:
//   'bg'      Graphics  — border + fill
//   'art'     Sprite    — card illustration (units / buildings)
//   'type'    Text
//   'name'    Text
//   'costBg'  Graphics
//   'cost'    Text
//   'overlay' Graphics
//   'eraser'  Graphics

function createCardSlot(): PIXI.Container {
  const c = new PIXI.Container();

  const bg       = new PIXI.Graphics(); bg.name       = 'bg';
  const art      = new PIXI.Sprite(PIXI.Texture.EMPTY); art.name = 'art';
  art.anchor.set(0.5);
  art.visible = false;
  const typeText = new PIXI.Text('', { fontSize: 9,  fill: 0x888888 }); typeText.name = 'type';
  typeText.x = 4; typeText.y = 2;
  const nameText = new PIXI.Text('', {
    fontSize: 13, fill: 0x222222, wordWrap: true, align: 'center', fontWeight: 'bold',
  }); nameText.name = 'name';
  const costBg   = new PIXI.Graphics(); costBg.name   = 'costBg';
  const costText = new PIXI.Text('', { fontSize: 14, fill: 0xffffff, fontWeight: 'bold' });
  costText.name  = 'cost';
  const overlay  = new PIXI.Graphics(); overlay.name  = 'overlay';
  const eraser   = new PIXI.Graphics(); eraser.name   = 'eraser';

  c.addChild(bg, art, typeText, nameText, costBg, costText, overlay, eraser);
  return c;
}

function resetCardSlot(c: PIXI.Container): void {
  c.removeFromParent();
  c.alpha = 1;
  c.y     = 0;
  (c.getChildByName('bg')      as PIXI.Graphics).clear();
  (c.getChildByName('costBg')  as PIXI.Graphics).clear();
  (c.getChildByName('overlay') as PIXI.Graphics).clear();
  (c.getChildByName('eraser')  as PIXI.Graphics).clear();
  (c.getChildByName('type')    as PIXI.Text).text = '';
  (c.getChildByName('name')    as PIXI.Text).text = '';
  (c.getChildByName('cost')    as PIXI.Text).text = '';
  const art = c.getChildByName('art') as PIXI.Sprite;
  art.texture = PIXI.Texture.EMPTY;
  art.visible = false;
}

// ── HandView ───────────────────────────────────────────────────────────────────

/**
 * Purely visual — no PIXI interactive/hitArea.
 * Input is handled by GameRenderer via InputManager.
 * Use hitTestCardIndex() for manual hit-testing.
 */
export class HandView {
  readonly container: PIXI.Container;

  private slots:         PIXI.Container[] = [];
  private selectedIndex: number | null    = null;
  private lastSyncKey:   string           = '';
  private artTextures    = new Map<string, PIXI.Texture>();

  private readonly layout: ILayout;
  startX = 0;
  baseY  = 0;

  private readonly pool = new ObjectPool<PIXI.Container>(
    createCardSlot,
    resetCardSlot,
    6,
  );

  constructor(layout: ILayout) {
    this.container = new PIXI.Container();
    this.layout    = layout;
  }

  // ── Per-frame sync ─────────────────────────────────────────────────────────

  sync(player: Player): void {
    const hand    = player.hand.slots;
    const syncKey = hand.map((s, i) =>
      `${i}:${s?.card.id ?? 'x'}:${s?.refreshRemainingTicks ?? 0}:${this.selectedIndex === i}`
    ).join('|') + `|${player.coins}`;

    if (syncKey === this.lastSyncKey) return;
    this.lastSyncKey = syncKey;

    for (const slot of this.slots) this.pool.release(slot);
    this.container.removeChildren();
    this.slots = [];

    const { cardWidth: cw, cardHeight: ch, cardMargin: cm, handRect } = this.layout;
    const numCards   = hand.length;
    const totalWidth = numCards * (cw + cm) - cm;

    this.startX = handRect.x + (handRect.w - totalWidth) / 2;
    this.baseY  = handRect.y + (handRect.h - ch) / 2;

    hand.forEach((handSlot, i) => {
      const isSelected = this.selectedIndex === i;
      const slot = this.pool.acquire();
      this.configureSlot(slot, handSlot?.card ?? null, i, player.coins, isSelected, cw, ch);

      if (handSlot) {
        const progress = 1 - (handSlot.refreshRemainingTicks / handSlot.refreshDurationTicks);
        this.drawEraser(slot.getChildByName('eraser') as PIXI.Graphics, progress, cw, ch);
      }

      slot.x = this.startX + i * (cw + cm);
      slot.y = this.baseY - (isSelected ? CARD_LIFT : 0);
      this.container.addChild(slot);
      this.slots.push(slot);
    });
  }

  // ── Public control ─────────────────────────────────────────────────────────

  setSelectedCard(index: number | null): void {
    this.selectedIndex = index;
    this.lastSyncKey = '';
  }

  clearSelection(): void {
    this.selectedIndex = null;
    this.lastSyncKey = '';
  }

  slotCenter(index: number): { x: number; y: number } {
    const { cardWidth: cw, cardHeight: ch, cardMargin: cm } = this.layout;
    return {
      x: this.startX + index * (cw + cm) + cw / 2,
      y: this.baseY + ch / 2,
    };
  }

  /**
   * Returns the card slot index (0-based) at design-space point (x, y), or -1.
   * Does NOT check affordability — caller should verify player.coins.
   */
  hitTestCardIndex(x: number, y: number): number {
    const { cardWidth: cw, cardHeight: ch, cardMargin: cm } = this.layout;
    // Extend top boundary to cover selected card's lifted position
    const topY = this.baseY - CARD_LIFT;
    if (y < topY || y > this.baseY + ch) return -1;
    for (let i = 0; i < this.slots.length; i++) {
      const slotX = this.startX + i * (cw + cm);
      if (x >= slotX && x <= slotX + cw) return i;
    }
    return -1;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private configureSlot(
    c: PIXI.Container,
    card: CardDefinition | null,
    _index: number,
    coins: number,
    isSelected: boolean,
    cardW: number,
    cardH: number,
  ): void {
    const canAfford   = card !== null && coins >= card.cost;
    const borderColor = isSelected ? CARD_SELECTED_BORDER : CARD_BORDER;
    const borderWidth = isSelected ? 3 : 2;

    const nameStyle = (c.getChildByName('name') as PIXI.Text).style;
    nameStyle.wordWrapWidth = cardW - 8;

    const bg = c.getChildByName('bg') as PIXI.Graphics;
    bg.lineStyle(borderWidth, borderColor);
    bg.beginFill(CARD_BG);
    bg.drawRoundedRect(0, 0, cardW, cardH, 4);
    bg.endFill();

    if (card) {
      (c.getChildByName('type') as PIXI.Text).text = this.cardTypeChar(card);
      const nameText = c.getChildByName('name') as PIXI.Text;
      nameText.text = t(card.nameKey);
      nameText.x = (cardW - nameText.width) / 2;
      nameText.y = cardH - nameText.height - 6;

      this.configureArt(c.getChildByName('art') as PIXI.Sprite, card, cardW, cardH);

      const costBg = c.getChildByName('costBg') as PIXI.Graphics;
      costBg.beginFill(canAfford ? 0x2244aa : 0xaa4422);
      costBg.drawCircle(cardW - 14, cardH - 14, 12);
      costBg.endFill();

      const costText = c.getChildByName('cost') as PIXI.Text;
      costText.text = String(card.cost);
      costText.x    = cardW  - 14 - costText.width  / 2;
      costText.y    = cardH - 14 - costText.height / 2;

      if (!canAfford) {
        const overlay = c.getChildByName('overlay') as PIXI.Graphics;
        overlay.beginFill(0xffffff, 0.45);
        overlay.drawRoundedRect(0, 0, cardW, cardH, 4);
        overlay.endFill();
      }
    }
  }

  private configureArt(art: PIXI.Sprite, card: CardDefinition, cardW: number, cardH: number): void {
    const key = cardArtKey(card);
    if (key === null) {
      art.visible = false;
      return;
    }

    let tex = this.artTextures.get(key);
    if (!tex) {
      tex = PIXI.Texture.from(CARD_ART_URLS[key]);
      if (!tex.baseTexture.valid) {
        // Texture loads async — force a re-sync once ready so size can be computed
        tex.baseTexture.once('loaded', () => { this.lastSyncKey = ''; });
      }
      this.artTextures.set(key, tex);
    }

    if (!tex.baseTexture.valid) {
      art.visible = false;
      return;
    }

    // Fit into the area between the type row and the name/cost row, keep aspect
    const boxW  = cardW - 16;
    const boxY0 = 16;
    const boxY1 = cardH - 28;
    const scale = Math.min(boxW / tex.width, (boxY1 - boxY0) / tex.height);

    art.texture = tex;
    art.scale.set(scale);
    art.position.set(cardW / 2, (boxY0 + boxY1) / 2);
    art.visible = true;
  }

  private drawEraser(gfx: PIXI.Graphics, progress: number, cardW: number, cardH: number): void {
    gfx.clear();
    if (progress <= 0) return;
    const coverH = Math.round(cardH * progress);
    const y = cardH - coverH;
    gfx.beginFill(ERASER_COLOR, ERASER_ALPHA);
    gfx.drawRoundedRect(1, y, cardW - 2, coverH, progress >= 1 ? 4 : 0);
    gfx.endFill();
  }

  private cardTypeChar(card: CardDefinition): string {
    switch (card.cardType) {
      case CardType.Unit:     return 'U';
      case CardType.Building: return 'B';
      case CardType.Spell:    return 'S';
    }
  }
}
