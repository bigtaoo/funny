import * as PIXI from 'pixi.js-legacy';
import { BASE_HP, BASE_UPGRADE_COSTS } from '../game/config';
import { GameState } from '../game/GameState';
import { OwnerId } from '../game/types';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEXT_STYLE    = { fontSize: 14, fill: 0x222222, fontFamily: 'monospace' } as const;
const SMALL_STYLE   = { fontSize: 11, fill: 0x555555, fontFamily: 'monospace' } as const;
const BTN_W         = 88;
const BTN_H         = 30;
const STRIP_HEIGHT  = 52;

// HP bar — 10 cells, each 10% of max HP
const HP_CELLS      = 10;
const HP_CELL_W     = 14;
const HP_CELL_H     = 10;
const HP_CELL_GAP   = 2;
const HP_BAR_TOTAL  = HP_CELLS * (HP_CELL_W + HP_CELL_GAP) - HP_CELL_GAP;

// ─── HUDView ──────────────────────────────────────────────────────────────────

/**
 * HUD strips at the top and bottom of the screen.
 *
 * Top strip  : [ Timer ]          [ enemy base HP bar ]       [ ⚙ ]
 * Bottom strip: [ coins + icon ]   [ player base HP bar ]      [ upgrade btn ]
 *
 * The base HP bars are positioned so they appear directly above/below the
 * corresponding base on the battlefield.
 */
export class HUDView {
  readonly container: PIXI.Container;

  /**
   * Called when the player starts dragging the upgrade button.
   * Provides the screen-space center of the button so GameRenderer can place the ghost.
   */
  onUpgradeDragStart: ((centerX: number, centerY: number) => void) | null = null;

  /** Called when the settings (gear) button is tapped. Wired by GameRenderer. */
  onSettingsPressed: (() => void) | null = null;

  /** Called when the player confirms "exit to lobby" from the pause overlay. */
  onExitToLobby: (() => void) | null = null;

  private pauseOverlay: PIXI.Container | null = null;

  private timerText!:    PIXI.Text;
  private coinText!:     PIXI.Text;

  private playerHpGfx!:  PIXI.Graphics;
  private enemyHpGfx!:   PIXI.Graphics;

  private upgradeBtnBg!:    PIXI.Graphics;
  private upgradeBtnLabel!: PIXI.Text;

  private settingsBtnBg!:   PIXI.Graphics;

  private gameOverOverlay: PIXI.Container | null = null;

  private readonly screenWidth:  number;
  private readonly screenHeight: number;

  /** X-center of the base on screen — used to position HP bars */
  private readonly baseCenterX: number;

  constructor(screenWidth: number, screenHeight: number, baseCenterX: number) {
    this.container   = new PIXI.Container();
    this.screenWidth  = screenWidth;
    this.screenHeight = screenHeight;
    this.baseCenterX  = baseCenterX;
    this.build();
  }

  // ─── Per-frame sync ───────────────────────────────────────────────────────

  sync(state: GameState): void {
    const p = state.bottomPlayer;
    const e = state.topPlayer;

    // Timer
    this.timerText.text = this.formatTime(state.elapsedTicks / 30);

    // Coins
    this.coinText.text = `⬤ ${p.coins}`;

    // HP bars
    this.drawHpBar(this.playerHpGfx, p.baseHp, BASE_HP, false);
    this.drawHpBar(this.enemyHpGfx,  e.baseHp, BASE_HP, true);

    // Upgrade button
    const cost = p.nextUpgradeCost;
    if (cost === null) {
      this.upgradeBtnLabel.text = 'MAX';
      this.setUpgradeBtnEnabled(false);
    } else {
      const canAfford = p.coins >= cost;
      this.upgradeBtnLabel.text = `↑ ${cost}g`;
      this.setUpgradeBtnEnabled(canAfford);
    }
  }

  /** Show the pause overlay. Idempotent. */
  showPause(): void {
    if (this.pauseOverlay) return;

    const w = this.screenWidth;
    const h = this.screenHeight;

    const overlay = new PIXI.Container();

    // Dim background
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.6);
    dim.drawRect(0, 0, w, h);
    dim.endFill();
    dim.interactive = true; // block events to game below

    // Panel
    const panelW = Math.round(w * 0.68);
    const panelH = Math.round(h * 0.28);
    const panelX = (w - panelW) / 2;
    const panelY = (h - panelH) / 2;

    const panel = new PIXI.Graphics();
    panel.beginFill(0xfaf6ee);
    panel.lineStyle(2, 0x333333);
    panel.drawRoundedRect(panelX, panelY, panelW, panelH, 8);
    panel.endFill();

    const title = new PIXI.Text('PAUSED', {
      fontSize: Math.round(panelH * 0.22),
      fill: 0x222222,
      fontWeight: 'bold',
      fontFamily: 'monospace',
    });
    title.anchor.set(0.5, 0);
    title.x = w / 2;
    title.y = panelY + panelH * 0.1;

    // Resume button
    const btnW  = Math.round(panelW * 0.72);
    const btnH  = Math.round(panelH * 0.22);
    const btnGap = Math.round(panelH * 0.07);
    const btn1Y  = panelY + panelH * 0.42;
    const btn2Y  = btn1Y + btnH + btnGap;
    const btnX   = (w - btnW) / 2;

    const resumeBg = this.makeBtn(btnX, btn1Y, btnW, btnH, 0x2c2c2a, 'RESUME', 0xffffff);
    resumeBg.interactive = true;
    resumeBg.cursor = 'pointer';
    resumeBg.on('pointertap', () => this.hidePause());

    // Exit button
    const exitBg = this.makeBtn(btnX, btn2Y, btnW, btnH, 0xf0ece0, 'EXIT TO LOBBY', 0x444444, 0x888888);
    exitBg.interactive = true;
    exitBg.cursor = 'pointer';
    exitBg.on('pointertap', () => {
      this.hidePause();
      this.onExitToLobby?.();
    });

    overlay.addChild(dim, panel, title, resumeBg, exitBg);
    this.container.addChild(overlay);
    this.pauseOverlay = overlay;
  }

  /** Hide the pause overlay. */
  hidePause(): void {
    if (!this.pauseOverlay) return;
    this.container.removeChild(this.pauseOverlay);
    this.pauseOverlay.destroy({ children: true });
    this.pauseOverlay = null;
  }

  get isPaused(): boolean {
    return this.pauseOverlay !== null;
  }

  private makeBtn(
    x: number, y: number, w: number, h: number,
    bgColor: number, label: string, textColor: number,
    borderColor = 0x333333,
  ): PIXI.Container {
    const c = new PIXI.Container();

    const bg = new PIXI.Graphics();
    bg.beginFill(bgColor);
    bg.lineStyle(1, borderColor);
    bg.drawRoundedRect(0, 0, w, h, 6);
    bg.endFill();

    const txt = new PIXI.Text(label, {
      fontSize: Math.round(h * 0.42),
      fill: textColor,
      fontWeight: 'bold',
      fontFamily: 'monospace',
    });
    txt.anchor.set(0.5, 0.5);
    txt.x = w / 2;
    txt.y = h / 2;

    c.addChild(bg, txt);
    c.x = x;
    c.y = y;

    // Make the whole container interactive
    bg.interactive = true;
    bg.hitArea = new PIXI.Rectangle(0, 0, w, h);

    return c;
  }

  /** winner=null means draw */
  showGameOver(winner: OwnerId | null): void {
    if (this.gameOverOverlay) return;

    const overlay = new PIXI.Container();
    const bg = new PIXI.Graphics();
    bg.beginFill(0x000000, 0.55);
    bg.drawRoundedRect(-160, -50, 320, 100, 8);
    bg.endFill();

    const msg  = winner === null ? 'Draw' : (winner === 0 ? 'You Win!' : 'You Lose');
    const text = new PIXI.Text(msg, { fontSize: 38, fill: 0xffffff, fontWeight: 'bold' });
    text.anchor.set(0.5);

    overlay.addChild(bg, text);
    overlay.x = this.screenWidth  / 2;
    overlay.y = this.screenHeight / 2;
    this.container.addChild(overlay);
    this.gameOverOverlay = overlay;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private build(): void {
    const w = this.screenWidth;
    const h = this.screenHeight;
    const cx = this.baseCenterX;

    // ── Top strip background ──────────────────────────────────────────────
    const topBg = new PIXI.Graphics();
    topBg.beginFill(0xede5d5, 0.92);
    topBg.drawRect(0, 0, w, STRIP_HEIGHT);
    topBg.endFill();

    // Timer — top-left
    this.timerText = new PIXI.Text('0:00', { ...TEXT_STYLE, fontSize: 16 });
    this.timerText.x = 14;
    this.timerText.y = (STRIP_HEIGHT - this.timerText.height) / 2;

    // Enemy HP bar — top strip, centered on base X
    this.enemyHpGfx = new PIXI.Graphics();
    this.enemyHpGfx.x = cx - HP_BAR_TOTAL / 2;
    this.enemyHpGfx.y = (STRIP_HEIGHT - HP_CELL_H) / 2;

    // Settings button — top-right
    this.settingsBtnBg = new PIXI.Graphics();
    const sBtnX = w - BTN_W - 8;
    const sBtnY = (STRIP_HEIGHT - BTN_H) / 2;
    this.settingsBtnBg.x = sBtnX;
    this.settingsBtnBg.y = sBtnY;
    this.drawSettingsBtn();

    const settingsLabel = new PIXI.Text('⚙', { fontSize: 18, fill: 0x333333 });
    settingsLabel.anchor.set(0.5);
    settingsLabel.x = sBtnX + BTN_W / 2;
    settingsLabel.y = sBtnY + BTN_H / 2;

    this.settingsBtnBg.interactive = true;
    this.settingsBtnBg.cursor = 'pointer';
    this.settingsBtnBg.on('pointertap', () => {
      if (this.onSettingsPressed) this.onSettingsPressed();
    });

    // ── Bottom strip background ───────────────────────────────────────────
    const botBg = new PIXI.Graphics();
    botBg.beginFill(0xede5d5, 0.92);
    botBg.drawRect(0, h - STRIP_HEIGHT, w, STRIP_HEIGHT);
    botBg.endFill();

    // Coins — bottom-left
    this.coinText = new PIXI.Text('⬤ 0', TEXT_STYLE);
    this.coinText.x = 14;
    this.coinText.y = h - STRIP_HEIGHT + (STRIP_HEIGHT - this.coinText.height) / 2;

    // Player HP bar — bottom strip, centered on base X
    this.playerHpGfx = new PIXI.Graphics();
    this.playerHpGfx.x = cx - HP_BAR_TOTAL / 2;
    this.playerHpGfx.y = h - STRIP_HEIGHT + (STRIP_HEIGHT - HP_CELL_H) / 2;

    // Upgrade button — bottom-right
    this.upgradeBtnBg   = new PIXI.Graphics();
    this.upgradeBtnLabel = new PIXI.Text(`↑ ${BASE_UPGRADE_COSTS[0]}g`, SMALL_STYLE);

    this.upgradeBtnBg.x = w - BTN_W - 8;
    this.upgradeBtnBg.y = h - STRIP_HEIGHT + (STRIP_HEIGHT - BTN_H) / 2;
    this.upgradeBtnLabel.anchor.set(0.5);
    this.upgradeBtnLabel.x = this.upgradeBtnBg.x + BTN_W / 2;
    this.upgradeBtnLabel.y = this.upgradeBtnBg.y + BTN_H / 2;

    this.upgradeBtnBg.interactive = true;
    this.upgradeBtnBg.cursor = 'grab';
    this.upgradeBtnBg.on('pointerdown', (e: PIXI.FederatedPointerEvent) => {
      e.stopPropagation();
      if (this.onUpgradeDragStart) {
        const cx = this.upgradeBtnBg.x + BTN_W / 2;
        const cy = this.upgradeBtnBg.y + BTN_H / 2;
        this.onUpgradeDragStart(cx, cy);
      }
    });
    this.setUpgradeBtnEnabled(false);

    this.container.addChild(
      topBg, this.timerText, this.enemyHpGfx, this.settingsBtnBg, settingsLabel,
      botBg, this.coinText, this.playerHpGfx, this.upgradeBtnBg, this.upgradeBtnLabel,
    );
  }

  /**
   * Draw a 10-cell grid HP bar.
   * Each filled cell = 10 HP. Low HP cells turn red.
   * `flipped` = true for the enemy bar (rendered upside-down, cells read right-to-left).
   */
  private drawHpBar(gfx: PIXI.Graphics, hp: number, maxHp: number, _flipped: boolean): void {
    gfx.clear();
    const filledCells = Math.ceil((hp / maxHp) * HP_CELLS);

    for (let i = 0; i < HP_CELLS; i++) {
      const filled = i < filledCells;
      const danger = filledCells <= 3;

      const x = i * (HP_CELL_W + HP_CELL_GAP);

      if (filled) {
        gfx.beginFill(danger ? 0xcc3333 : 0x333333, 0.85);
      } else {
        gfx.beginFill(0xdddddd, 0.5);
      }
      gfx.lineStyle(1, 0x888888, 0.4);
      gfx.drawRect(x, 0, HP_CELL_W, HP_CELL_H);
      gfx.endFill();
    }
  }

  private drawSettingsBtn(): void {
    this.settingsBtnBg.clear();
    this.settingsBtnBg.beginFill(0xf0ece0);
    this.settingsBtnBg.lineStyle(1, 0xaaaaaa);
    this.settingsBtnBg.drawRoundedRect(0, 0, BTN_W, BTN_H, 4);
    this.settingsBtnBg.endFill();
  }

  private setUpgradeBtnEnabled(enabled: boolean): void {
    this.upgradeBtnBg.clear();
    this.upgradeBtnBg.beginFill(enabled ? 0x2c2c2a : 0x999999);
    this.upgradeBtnBg.lineStyle(1, 0x333333);
    this.upgradeBtnBg.drawRoundedRect(0, 0, BTN_W, BTN_H, 4);
    this.upgradeBtnBg.endFill();
    this.upgradeBtnLabel.style.fill = enabled ? 0xffffff : 0xdddddd;
    this.upgradeBtnBg.interactive = enabled;
    this.upgradeBtnBg.cursor = enabled ? 'pointer' : 'default';
  }

  private formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
