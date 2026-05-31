import * as PIXI from 'pixi.js-legacy';
import { Player } from '../game/Player';
import { CardDefinition, CardType } from '../game/types';

const CARD_WIDTH    = 60;
const CARD_HEIGHT   = 80;
const CARD_MARGIN   = 8;
const CARD_BG       = 0xfaf6ee; // notebook paper
const CARD_BORDER   = 0x333333;
const CARD_SELECTED_BORDER = 0xffcc00; // yellow outline when selected
const CARD_LIFT     = 14;        // px up when selected

export class HandView {
  readonly container: PIXI.Container;

  /**
   * Called when the player taps an affordable card.
   * The renderer enters placement mode; the handIndex identifies which card to play.
   */
  onCardSelected: ((handIndex: number) => void) | null = null;

  private cards: PIXI.Container[] = [];
  private selectedIndex: number | null = null;

  /** Cache key: serialized hand + coins + selectedIndex — rebuild only when changed. */
  private lastSyncKey: string = '';

  private readonly screenWidth:  number;
  private readonly screenHeight: number;

  constructor(screenWidth: number, screenHeight: number) {
    this.container    = new PIXI.Container();
    this.screenWidth  = screenWidth;
    this.screenHeight = screenHeight;
  }

  // ─── Per-frame sync ───────────────────────────────────────────────────────

  sync(player: Player): void {
    const hand = player.hand.cards;
    const syncKey = `${player.coins}|${this.selectedIndex}|${hand.map(c => c?.id ?? 'x').join(',')}`;
    if (syncKey === this.lastSyncKey) return; // nothing changed, skip rebuild
    this.lastSyncKey = syncKey;

    // Destroy old card containers to release PIXI Text textures (prevents memory leak)
    for (const card of this.cards) {
      card.destroy({ children: true });
    }
    this.container.removeChildren();
    this.cards = [];

    const totalWidth = hand.length * (CARD_WIDTH + CARD_MARGIN) - CARD_MARGIN;
    const startX = (this.screenWidth - totalWidth) / 2;
    const baseY  = this.screenHeight - CARD_HEIGHT - 16;

    hand.forEach((card, i) => {
      const isSelected = this.selectedIndex === i;
      const cardContainer = this.buildCard(card, i, player.coins, isSelected);
      cardContainer.x = startX + i * (CARD_WIDTH + CARD_MARGIN);
      cardContainer.y = baseY - (isSelected ? CARD_LIFT : 0);
      this.container.addChild(cardContainer);
      this.cards.push(cardContainer);
    });
  }

  // ─── Public control ───────────────────────────────────────────────────────

  /** Called by GameRenderer to apply or clear selection highlight. */
  setSelectedCard(index: number | null): void {
    this.selectedIndex = index;
    this.lastSyncKey = ''; // invalidate cache so next sync rebuilds
  }

  clearSelection(): void {
    this.selectedIndex = null;
    this.lastSyncKey = '';
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private buildCard(
    card: CardDefinition | null,
    index: number,
    coins: number,
    isSelected: boolean,
  ): PIXI.Container {
    const c   = new PIXI.Container();
    const gfx = new PIXI.Graphics();

    const canAfford = card !== null && coins >= card.cost;
    const borderColor = isSelected ? CARD_SELECTED_BORDER : CARD_BORDER;
    const borderWidth = isSelected ? 3 : 2;

    // Card background
    gfx.lineStyle(borderWidth, borderColor);
    gfx.beginFill(CARD_BG);
    gfx.drawRoundedRect(0, 0, CARD_WIDTH, CARD_HEIGHT, 4);
    gfx.endFill();
    c.addChild(gfx);

    if (card) {
      // Card type icon (tiny label top-left)
      const typeLabel = this.cardTypeChar(card);
      const typeText  = new PIXI.Text(typeLabel, { fontSize: 9, fill: 0x888888 });
      typeText.x = 4;
      typeText.y = 2;
      c.addChild(typeText);

      // Card name
      const name = new PIXI.Text(card.name, {
        fontSize: 10,
        fill: 0x222222,
        wordWrap: true,
        wordWrapWidth: CARD_WIDTH - 8,
        align: 'center',
      });
      name.x = 4;
      name.y = 14;
      c.addChild(name);

      // Cost badge (bottom-right circle)
      const costBg = new PIXI.Graphics();
      costBg.beginFill(canAfford ? 0x2244aa : 0xaa4422);
      costBg.drawCircle(CARD_WIDTH - 14, CARD_HEIGHT - 14, 12);
      costBg.endFill();

      const cost = new PIXI.Text(String(card.cost), {
        fontSize: 14,
        fill: 0xffffff,
        fontWeight: 'bold',
      });
      cost.x = CARD_WIDTH - 14 - cost.width / 2;
      cost.y = CARD_HEIGHT - 14 - cost.height / 2;
      c.addChild(costBg, cost);

      // Grey overlay when can't afford
      if (!canAfford) {
        const overlay = new PIXI.Graphics();
        overlay.beginFill(0xffffff, 0.45);
        overlay.drawRoundedRect(0, 0, CARD_WIDTH, CARD_HEIGHT, 4);
        overlay.endFill();
        c.addChild(overlay);
      }

      // Interaction (only tappable when affordable)
      if (canAfford) {
        c.interactive = true;
        c.cursor = 'pointer';
        c.on('pointertap', () => {
          if (this.onCardSelected) this.onCardSelected(index);
        });
      }
    }

    return c;
  }

  private cardTypeChar(card: CardDefinition): string {
    switch (card.cardType) {
      case CardType.Unit:     return 'U';
      case CardType.Building: return 'B';
      case CardType.Spell:    return 'S';
    }
  }
}
