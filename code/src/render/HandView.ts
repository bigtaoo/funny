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

// ─── Card slot structure ──────────────────────────────────────────────────────
//
// Each pooled Container always has the same fixed set of named children.
// On acquire we configure them; on release we reset and return.
//
// Children (by name):
//   'bg'      PIXI.Graphics  — rounded-rect border + fill
//   'type'    PIXI.Text      — 'U' / 'B' / 'S'
//   'name'    PIXI.Text      — card name
//   'costBg'  PIXI.Graphics  — cost circle
//   'cost'    PIXI.Text      — cost number
//   'overlay' PIXI.Graphics  — grey tint when can't afford

function createCardSlot(): PIXI.Container {
  const c = new PIXI.Container();

  const bg = new PIXI.Graphics();
  bg.name = 'bg';

  const typeText = new PIXI.Text('', { fontSize: 9, fill: 0x888888 });
  typeText.name = 'type';
  typeText.x = 4;
  typeText.y = 2;

  const nameText = new PIXI.Text('', {
    fontSize: 10,
    fill: 0x222222,
    wordWrap: true,
    wordWrapWidth: CARD_WIDTH - 8,
    align: 'center',
  });
  nameText.name = 'name';
  nameText.x = 4;
  nameText.y = 14;

  const costBg = new PIXI.Graphics();
  costBg.name = 'costBg';

  const costText = new PIXI.Text('', { fontSize: 14, fill: 0xffffff, fontWeight: 'bold' });
  costText.name = 'cost';

  const overlay = new PIXI.Graphics();
  overlay.name = 'overlay';

  c.addChild(bg, typeText, nameText, costBg, costText, overlay);
  return c;
}

function resetCardSlot(c: PIXI.Container): void {
  c.removeFromParent();
  c.removeAllListeners();
  c.interactive = false;
  c.cursor      = 'default';
  c.alpha       = 1;
  c.y           = 0; // reset lift
  (c.getChildByName('bg')      as PIXI.Graphics).clear();
  (c.getChildByName('costBg')  as PIXI.Graphics).clear();
  (c.getChildByName('overlay') as PIXI.Graphics).clear();
  (c.getChildByName('type')    as PIXI.Text).text = '';
  (c.getChildByName('name')    as PIXI.Text).text = '';
  (c.getChildByName('cost')    as PIXI.Text).text = '';
}

// ─── HandView ─────────────────────────────────────────────────────────────────

export class HandView {
  readonly container: PIXI.Container;

  onCardSelected: ((handIndex: number) => void) | null = null;

  private slots: PIXI.Container[] = [];
  private selectedIndex: number | null = null;

  /** Cache key — rebuild only when hand/coins/selection actually change. */
  private lastSyncKey: string = '';

  private readonly screenWidth:  number;
  private readonly screenHeight: number;

  private readonly pool = new ObjectPool<PIXI.Container>(
    createCardSlot,
    resetCardSlot,
    6, // prewarm one full hand
  );

  constructor(screenWidth: number, screenHeight: number) {
    this.container   = new PIXI.Container();
    this.screenWidth  = screenWidth;
    this.screenHeight = screenHeight;
  }

  // ─── Per-frame sync ───────────────────────────────────────────────────────

  sync(player: Player): void {
    const hand    = player.hand.cards;
    const syncKey = `${player.coins}|${this.selectedIndex}|${hand.map(c => c?.id ?? 'x').join(',')}`;
    if (syncKey === this.lastSyncKey) return;
    this.lastSyncKey = syncKey;

    // Return existing slots to pool
    for (const slot of this.slots) {
      this.pool.release(slot);
    }
    this.container.removeChildren();
    this.slots = [];

    const totalWidth = hand.length * (CARD_WIDTH + CARD_MARGIN) - CARD_MARGIN;
    const startX     = (this.screenWidth - totalWidth) / 2;
    const baseY      = this.screenHeight - CARD_HEIGHT - 16;

    hand.forEach((card, i) => {
      const isSelected = this.selectedIndex === i;
      const slot = this.pool.acquire();
      this.configureSlot(slot, card, i, player.coins, isSelected);
      slot.x = startX + i * (CARD_WIDTH + CARD_MARGIN);
      slot.y = baseY - (isSelected ? CARD_LIFT : 0);
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

    // Background / border
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
        c.on('pointertap', () => {
          if (this.onCardSelected) this.onCardSelected(index);
        });
      }
    }
  }

  private cardTypeChar(card: CardDefinition): string {
    switch (card.cardType) {
      case CardType.Unit:     return 'U';
      case CardType.Building: return 'B';
      case CardType.Spell:    return 'S';
    }
  }
}
