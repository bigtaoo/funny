import * as PIXI from 'pixi.js-legacy';
import { BASE_UPGRADE_COSTS } from '../game/config';
import { GameState } from '../game/GameState';
import { OwnerId } from '../game/types';

const TEXT_STYLE = { fontSize: 14, fill: 0x222222 } as const;
const BTN_W = 80;
const BTN_H = 26;

export class HUDView {
  readonly container: PIXI.Container;

  /** Called when the player taps the upgrade button. */
  onUpgradePressed: (() => void) | null = null;

  private coinText!:      PIXI.Text;
  private enemyCoinText!: PIXI.Text;
  private playerHpText!:  PIXI.Text;
  private enemyHpText!:   PIXI.Text;
  private timerText!:     PIXI.Text;

  private upgradeBtnBg!:   PIXI.Graphics;
  private upgradeBtnLabel!: PIXI.Text;

  private gameOverOverlay: PIXI.Container | null = null;

  private readonly screenWidth:  number;
  private readonly screenHeight: number;

  constructor(screenWidth: number, screenHeight: number) {
    this.container   = new PIXI.Container();
    this.screenWidth  = screenWidth;
    this.screenHeight = screenHeight;
    this.build();
  }

  // ─── Per-frame sync ───────────────────────────────────────────────────────

  sync(state: GameState): void {
    const p = state.bottomPlayer;
    const e = state.topPlayer;

    this.coinText.text      = `coins: ${Math.floor(p.coins)}`;
    this.enemyCoinText.text = `${Math.floor(e.coins)}`;
    this.playerHpText.text  = `HP: ${p.baseHp}`;
    this.enemyHpText.text   = `${e.baseHp}`;
    this.timerText.text     = this.formatTime(state.elapsedTime);

    // Upgrade button
    const cost = p.nextUpgradeCost;
    if (cost === null) {
      // Maxed out
      this.upgradeBtnLabel.text = 'MAX';
      this.setUpgradeBtnEnabled(false);
    } else {
      const canAfford = p.coins >= cost;
      this.upgradeBtnLabel.text = `UP ${cost}g`;
      this.setUpgradeBtnEnabled(canAfford);
    }
  }

  // ─── Game over overlay ────────────────────────────────────────────────────

  showGameOver(winner: OwnerId): void {
    if (this.gameOverOverlay) return;

    const overlay = new PIXI.Container();
    const bg = new PIXI.Graphics();
    bg.beginFill(0x000000, 0.6);
    bg.drawRect(-200, -60, 400, 120);
    bg.endFill();

    const msg  = winner === 0 ? 'You Win!' : 'You Lose';
    const text = new PIXI.Text(msg, { fontSize: 36, fill: 0xffffff, fontWeight: 'bold' });
    text.anchor.set(0.5);

    overlay.addChild(bg, text);
    overlay.x = this.screenWidth / 2;
    overlay.y = this.screenHeight / 2;
    this.container.addChild(overlay);
    this.gameOverOverlay = overlay;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private build(): void {
    const w = this.screenWidth;
    const h = this.screenHeight;

    // ── Top bar ──────────────────────────────────────────────────────────────
    this.playerHpText = new PIXI.Text('HP: 100', TEXT_STYLE);
    this.playerHpText.x = 8;
    this.playerHpText.y = 8;

    this.coinText = new PIXI.Text('coins: 0', TEXT_STYLE);
    this.coinText.x = 8;
    this.coinText.y = 26;

    this.timerText = new PIXI.Text('0:00', TEXT_STYLE);
    this.timerText.anchor.set(0.5, 0);
    this.timerText.x = w / 2;
    this.timerText.y = 8;

    this.enemyHpText = new PIXI.Text('100', { ...TEXT_STYLE, align: 'right' });
    this.enemyHpText.anchor.set(1, 0);
    this.enemyHpText.x = w - 8;
    this.enemyHpText.y = 8;

    this.enemyCoinText = new PIXI.Text('0', { ...TEXT_STYLE, align: 'right' });
    this.enemyCoinText.anchor.set(1, 0);
    this.enemyCoinText.x = w - 8;
    this.enemyCoinText.y = 26;

    // ── Upgrade button (bottom-right, above hand) ────────────────────────────
    const btnX = w - BTN_W - 8;
    const btnY = h - 80 - BTN_H - 12; // above the hand area

    this.upgradeBtnBg = new PIXI.Graphics();
    this.upgradeBtnBg.x = btnX;
    this.upgradeBtnBg.y = btnY;

    this.upgradeBtnLabel = new PIXI.Text(`UP ${BASE_UPGRADE_COSTS[0]}g`, {
      fontSize: 11,
      fill: 0xffffff,
      fontWeight: 'bold',
    });
    this.upgradeBtnLabel.anchor.set(0.5);
    this.upgradeBtnLabel.x = btnX + BTN_W / 2;
    this.upgradeBtnLabel.y = btnY + BTN_H / 2;

    this.upgradeBtnBg.interactive = true;
    this.upgradeBtnBg.cursor = 'pointer';
    this.upgradeBtnBg.on('pointertap', () => {
      if (this.onUpgradePressed) this.onUpgradePressed();
    });

    this.setUpgradeBtnEnabled(false); // start greyed (player starts with 0 coins)

    this.container.addChild(
      this.playerHpText,
      this.coinText,
      this.timerText,
      this.enemyHpText,
      this.enemyCoinText,
      this.upgradeBtnBg,
      this.upgradeBtnLabel,
    );
  }

  private setUpgradeBtnEnabled(enabled: boolean): void {
    this.upgradeBtnBg.clear();
    this.upgradeBtnBg.beginFill(enabled ? 0x44aa44 : 0x888888);
    this.upgradeBtnBg.lineStyle(1, 0x333333);
    this.upgradeBtnBg.drawRoundedRect(0, 0, BTN_W, BTN_H, 4);
    this.upgradeBtnBg.endFill();

    this.upgradeBtnBg.interactive = enabled;
    this.upgradeBtnBg.cursor = enabled ? 'pointer' : 'default';
  }

  private formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
