import * as PIXI from 'pixi.js-legacy';
import { GameState } from '../game/GameState';
import { Side } from '../game/types';

export class HUDView {
  readonly container: PIXI.Container;

  private coinText!: PIXI.Text;
  private enemyCoinText!: PIXI.Text;
  private playerHpText!: PIXI.Text;
  private enemyHpText!: PIXI.Text;
  private timerText!: PIXI.Text;
  private gameOverOverlay: PIXI.Container | null = null;

  constructor(screenWidth: number, screenHeight: number) {
    this.container = new PIXI.Container();
    this.build(screenWidth, screenHeight);
  }

  sync(state: GameState): void {
    const p = state.bottomPlayer;
    const e = state.topPlayer;

    this.coinText.text = `💰 ${Math.floor(p.coins)} / 30`;
    this.enemyCoinText.text = `${Math.floor(e.coins)} / 30`;
    this.playerHpText.text = `🏰 ${p.baseHp}`;
    this.enemyHpText.text = `${e.baseHp} 🏰`;
    this.timerText.text = this.formatTime(state.elapsedTime);
  }

  showGameOver(winner: Side): void {
    if (this.gameOverOverlay) return;

    const overlay = new PIXI.Container();
    const bg = new PIXI.Graphics();
    bg.beginFill(0x000000, 0.6);
    bg.drawRect(-200, -60, 400, 120);
    bg.endFill();

    const msg = winner === Side.Bottom ? '🎉 You Win!' : '💀 You Lose';
    const text = new PIXI.Text(msg, {
      fontSize: 36,
      fill: 0xffffff,
      fontWeight: 'bold',
    });
    text.anchor.set(0.5);

    overlay.addChild(bg, text);
    overlay.x = this.container.parent?.width / 2 ?? 200;
    overlay.y = this.container.parent?.height / 2 ?? 400;
    this.container.addChild(overlay);
    this.gameOverOverlay = overlay;
  }

  private build(w: number, _h: number): void {
    const style = { fontSize: 14, fill: 0x222222 };

    this.coinText = new PIXI.Text('💰 0 / 30', style);
    this.coinText.x = 8;
    this.coinText.y = 8;

    this.playerHpText = new PIXI.Text('🏰 100', style);
    this.playerHpText.x = 8;
    this.playerHpText.y = 28;

    this.timerText = new PIXI.Text('0:00', style);
    this.timerText.anchor.set(0.5, 0);
    this.timerText.x = w / 2;
    this.timerText.y = 8;

    this.enemyCoinText = new PIXI.Text('0 / 30', { ...style, align: 'right' });
    this.enemyCoinText.anchor.set(1, 0);
    this.enemyCoinText.x = w - 8;
    this.enemyCoinText.y = 8;

    this.enemyHpText = new PIXI.Text('100 🏰', { ...style, align: 'right' });
    this.enemyHpText.anchor.set(1, 0);
    this.enemyHpText.x = w - 8;
    this.enemyHpText.y = 28;

    this.container.addChild(
      this.coinText,
      this.playerHpText,
      this.timerText,
      this.enemyCoinText,
      this.enemyHpText,
    );
  }

  private formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
