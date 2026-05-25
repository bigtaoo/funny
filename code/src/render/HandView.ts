import * as PIXI from 'pixi.js-legacy';
import { Player } from '../game/Player';
import { CardDefinition, CardType } from '../game/types';

const CARD_WIDTH = 60;
const CARD_HEIGHT = 80;
const CARD_MARGIN = 8;
const CARD_BG = 0xfaf6ee;
const CARD_BORDER = 0x333333;
const CARD_DISABLED_TINT = 0xaaaaaa;

export class HandView {
  readonly container: PIXI.Container;

  /** Callback when player selects a card and a target */
  onCardPlayed: ((handIndex: number, col: number, row?: number) => void) | null = null;

  private cards: PIXI.Container[] = [];
  private selectedIndex: number | null = null;
  private readonly screenWidth: number;
  private readonly screenHeight: number;

  constructor(screenWidth: number, screenHeight: number) {
    this.container = new PIXI.Container();
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;
  }

  sync(player: Player): void {
    // Rebuild card display (simple approach — will optimise later)
    this.container.removeChildren();
    this.cards = [];

    const hand = player.hand.cards;
    const totalWidth = hand.length * (CARD_WIDTH + CARD_MARGIN) - CARD_MARGIN;
    const startX = (this.screenWidth - totalWidth) / 2;
    const y = this.screenHeight - CARD_HEIGHT - 16;

    hand.forEach((card, i) => {
      const cardContainer = this.buildCard(card, i, player.coins);
      cardContainer.x = startX + i * (CARD_WIDTH + CARD_MARGIN);
      cardContainer.y = y;
      this.container.addChild(cardContainer);
      this.cards.push(cardContainer);
    });
  }

  private buildCard(card: CardDefinition | null, index: number, coins: number): PIXI.Container {
    const c = new PIXI.Container();
    const gfx = new PIXI.Graphics();

    const canAfford = card !== null && coins >= card.cost;

    // Card background
    gfx.lineStyle(2, CARD_BORDER);
    gfx.beginFill(CARD_BG);
    gfx.drawRoundedRect(0, 0, CARD_WIDTH, CARD_HEIGHT, 4);
    gfx.endFill();
    c.addChild(gfx);

    if (card) {
      // Card name
      const name = new PIXI.Text(card.name, {
        fontSize: 10,
        fill: 0x222222,
        wordWrap: true,
        wordWrapWidth: CARD_WIDTH - 8,
        align: 'center',
      });
      name.x = 4;
      name.y = 8;
      c.addChild(name);

      // Cost badge
      const cost = new PIXI.Text(String(card.cost), {
        fontSize: 14,
        fill: 0xffffff,
        fontWeight: 'bold',
      });
      const costBg = new PIXI.Graphics();
      costBg.beginFill(canAfford ? 0x2244aa : 0xaa4422);
      costBg.drawCircle(CARD_WIDTH - 14, CARD_HEIGHT - 14, 12);
      costBg.endFill();
      cost.x = CARD_WIDTH - 14 - cost.width / 2;
      cost.y = CARD_HEIGHT - 14 - cost.height / 2;
      c.addChild(costBg, cost);

      // Disabled overlay
      if (!canAfford) {
        const overlay = new PIXI.Graphics();
        overlay.beginFill(0xffffff, 0.5);
        overlay.drawRoundedRect(0, 0, CARD_WIDTH, CARD_HEIGHT, 4);
        overlay.endFill();
        c.addChild(overlay);
      }

      // Interaction
      c.interactive = true;
      c.cursor = canAfford ? 'pointer' : 'not-allowed';
      c.on('pointertap', () => {
        if (canAfford) this.onCardTap(index);
      });
    }

    return c;
  }

  private onCardTap(index: number): void {
    if (this.selectedIndex === index) {
      // Deselect
      this.selectedIndex = null;
    } else {
      this.selectedIndex = index;
      // For unit/building cards, next board tap will provide the lane
      // For now, emit with a default col — full interaction in next pass
      // TODO: enter "placement mode" and intercept board taps
    }
  }
}
