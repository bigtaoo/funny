import * as PIXI from 'pixi.js-legacy';
import { Player } from '../game/Player';
import { CardDefinition, CardType } from '../game/types';
import { ObjectPool } from '../cache/ObjectPool';

const CARD_WIDTH    = 60;
const CARD_HEIGHT   = 80;
const CARD_MARGIN   = 8;
const CARD_BG       = 0xfaf6ee;
const CARD_BORDER   = 0x333333;
const CARD_SELECTED_BORDER = 0xffcc00;
const CARD_LIFT     = 14;
/** Eraser overlay color — notebook eraser tint (semi-transparent white/cream). */
const ERASER_COLOR  = 0xf0ece0;
const ERASER_ALPHA  = 0.62;

// ─── Card slot structure ──────────────────────────────────────────────────────
//
// Children by name:
//   'bg'      Graphics  — border + fill
//   'type'    Text      — 'U' / 'B' / 'S'
//   'name'    Text      — card name
//   'costBg'  Graphics  — cost circle
//   'cost'    Text      — cost number
//   'overlay' Graphics  — grey tint when can't afford
//   'eraser'  Graphics  — eraser refresh animation (bottom → top)

function createCardSlot(): PIXI.Container {
  const c = new PIXI.Container();

  const bg      = new PIXI.Graphics(); bg.name      = 'bg';
  const typeText = new PIXI.Text('', { fontSize: 9,  fill: 0x888888 }); typeText.name = 'type';
  typeText.x = 4; typeText.y = 2;
  const nameText = new PIXI.Text('', {
    fontSize: 10, fill: 0x222222, wordWrap: true,
    wordWrapWidth: CARD_WIDTH - 8, align: 'center',
  }); nameText.name = 'name';
  nameText.x = 4; nameText.y = 14;
  const costBg   = new PIXI.Graphics(); costBg.name   = 'costBg';
  const costText = new PIXI.Text('', { fontSize: 14, fill: 0xffffff, fontWeight: 'bold' });
  costText.name = 'cost';
  const overlay  = new PIXI.Graphics(); overlay.name  = 'overlay';
  const eraser   = new PIXI.Graphics(); eraser.name   = 'eraser';

  c.addChild(bg, typeText, nameText, costBg, costText, overlay, eraser);
  return c;
}

function resetCardSlot(c: PIXI.Container): void {
  c.removeFromParent();
  c.removeAllListeners();
  c.interactive = false;
  c.cursor      = 'default';
  c.alpha       = 1;
  c.y           = 0;
  (c.getChildByName('bg')      as PIXI.Graphics).clear();
  (c.getChildByName('costBg')  as PIXI.Graphics).clear();
  (c.getChildByName('overlay') as PIXI.Graphics).clear();
  (c.getChildByName('eraser')  as PIXI.Graphics).clear();
  (c.getChildByName('type')    as PIXI.Text).text = '';
  (c.getChildByName('name')    as PIXI.Text).text = '';
  (c.getChildByName('cost')    as PIXI.Text).text = '';
}

// ─── HandView ─────────────────────────────────────────────────────────────────

export class HandView {
  readonly container: PIXI.Container;

  /**
   * Called when the player starts dragging a card.
   * Returns false if the card is not playable (no coins etc.).
   */
  onCardDragStart: ((handIndex: number) => void) | null = null;

  private slots:         PIXI.Container[] = [];
  private selectedIndex: number | null    = null;
  private lastSyncKey:   string           = '';

  private readonly screenWidth:  number;
  private readonly screenHeight: number;
  private startX = 0;
  private baseY  = 0;

  private readonly pool = new ObjectPool<PIXI.Container>(
    createCardSlot,
    resetCardSlot,
    6,
  );

  constructor(screenWidth: number, screenHeight: number) {
    this.container    = new PIXI.Container();
    this.screenWidth  = screenWidth;
    this.screenHeight = screenHeight;
  }

  // ─── Per-frame sync ───────────────────────────────────────────────────────

  sync(player: Player): void {
    const hand    = player.hand.slots;
    const syncKey = hand.map((s, i) =>
      `${i}:${s?.card.id ?? 'x'}:${s?.refreshRemainingTicks ?? 0}:${this.selectedIndex === i}`
    ).join('|') + `|${player.coins}`;

    if (syncKey === this.lastSyncKey) return;
    this.lastSyncKey = syncKey;

    // Return old slots to pool
    for (const slot of this.slots) this.pool.release(slot);
    this.container.removeChildren();
    this.slots = [];

    const totalWidth = hand.length * (CARD_WIDTH + CARD_MARGIN) - CARD_MARGIN;
    this.startX = (this.screenWidth - totalWidth) / 2;
    this.baseY  = this.screenHeight - CARD_HEIGHT - 16;

    hand.forEach((handSlot, i) => {
      const isSelected = this.selectedIndex === i;
      const slot = this.pool.acquire();
      this.configureSlot(slot, handSlot?.card ?? null, i, player.coins, isSelected);

      // Eraser overlay — progress = 1 - (remaining / duration)
      if (handSlot) {
        const progress = 1 - (handSlot.refreshRemainingTicks / handSlot.refreshDurationTicks);
        this.drawEraser(slot.getChildByName('eraser') as PIXI.Graphics, progress);
      }

      slot.x = this.startX + i * (CARD_WIDTH + CARD_MARGIN);
      slot.y = this.baseY - (isSelected ? CARD_LIFT : 0);
      this.container.addChild(slot);
      this.slots.push(slot);
    });
  }

  // ─── Public control ───────────────────────────────────────────────────────

  setSelectedCard(index: number | null): void {
    this.selectedIndex = index;
    this.lastSyncKey = '';
  }

  clearSelection(): void {
    this.selectedIndex = null;
    this.lastSyncKey = '';
  }

  /**
   * Returns the screen position of the center of slot `index`.
   * Used by GameRenderer to position the drag ghost.
   */
  slotCenter(index: number): { x: number; y: number } {
    return {
      x: this.startX + index * (CARD_WIDTH + CARD_MARGIN) + CARD_WIDTH / 2,
      y: this.baseY + CARD_HEIGHT / 2,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private configureSlot(
    c: PIXI.Container,
    card: CardDefinition | null,
    index: number,
    coins: number,
    isSelected: boolean,
  ): void {
    const canAfford   = card !== null && coins >= card.cost;
    const borderColor = isSelected ? CARD_SELECTED_BORDER : CARD_BORDER;
    const borderWidth = isSelected ? 3 : 2;

    const bg = c.getChildByName('bg') as PIXI.Graphics;
    bg.lineStyle(borderWidth, borderColor);
    bg.beginFill(CARD_BG);
    bg.drawRoundedRect(0, 0, CARD_WIDTH, CARD_HEIGHT, 4);
    bg.endFill();

    if (card) {
      (c.getChildByName('type') as PIXI.Text).text = this.cardTypeChar(card);
      (c.getChildByName('name') as PIXI.Text).text = card.name;

      const costBg = c.getChildByName('costBg') as PIXI.Graphics;
      costBg.beginFill(canAfford ? 0x2244aa : 0xaa4422);
      costBg.drawCircle(CARD_WIDTH - 14, CARD_HEIGHT - 14, 12);
      costBg.endFill();

      const costText = c.getChildByName('cost') as PIXI.Text;
      costText.text = String(card.cost);
      costText.x    = CARD_WIDTH  - 14 - costText.width  / 2;
      costText.y    = CARD_HEIGHT - 14 - costText.height / 2;

      if (!canAfford) {
        const overlay = c.getChildByName('overlay') as PIXI.Graphics;
        overlay.beginFill(0xffffff, 0.45);
        overlay.drawRoundedRect(0, 0, CARD_WIDTH, CARD_HEIGHT, 4);
        overlay.endFill();
      }

      if (canAfford) {
        c.interactive = true;
        c.cursor      = 'pointer';
        // Drag start on pointerdown
        c.on('pointerdown', (e: PIXI.FederatedPointerEvent) => {
          e.stopPropagation();
          if (this.onCardDragStart) this.onCardDragStart(index);
        });
      }
    }
  }

  /**
   * Draw the eraser overlay from the bottom of the card upward.
   * `progress` is in [0, 1]: 0 = no overlay, 1 = fully covered.
   */
  private drawEraser(gfx: PIXI.Graphics, progress: number): void {
    gfx.clear();
    if (progress <= 0) return;

    const coverHeight = Math.round(CARD_HEIGHT * progress);
    const y = CARD_HEIGHT - coverHeight;

    gfx.beginFill(ERASER_COLOR, ERASER_ALPHA);
    gfx.drawRoundedRect(1, y, CARD_WIDTH - 2, coverHeight, progress >= 1 ? 4 : 0);
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
