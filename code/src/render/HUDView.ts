import * as PIXI from 'pixi.js-legacy';
import { BASE_HP, BASE_UPGRADE_COSTS } from '../game/config';
import { GameState } from '../game/GameState';
import { OwnerId } from '../game/types';
import { ILayout, Rect } from '../layout/ILayout';
import { t } from '../i18n';

// ── Constants ─────────────────────────────────────────────────────────────────

const TEXT_STYLE  = { fontSize: 14, fill: 0x222222, fontFamily: 'monospace' } as const;
const SMALL_STYLE = { fontSize: 11, fill: 0x555555, fontFamily: 'monospace' } as const;
const BTN_W       = 88;
const BTN_H       = 30;

const HP_CELLS    = 10;
const HP_CELL_W   = 14;
const HP_CELL_H   = 10;
const HP_CELL_GAP = 2;
const HP_BAR_W    = HP_CELLS * (HP_CELL_W + HP_CELL_GAP) - HP_CELL_GAP;

// ── HUDView ────────────────────────────────────────────────────────────────────

/**
 * HUD strips — purely visual, no PIXI interactive elements.
 * All input is routed through InputManager → GameRenderer → this view.
 *
 * Hit rects (design space) are exposed via getters so GameRenderer can
 * do manual hit-testing platform-agnostically.
 */
export class HUDView {
  readonly container: PIXI.Container;
  /** Bottom-strip background — must be rendered BEHIND the hand cards. */
  readonly backgroundContainer: PIXI.Container;

  /** Fired by GameRenderer when settings button is tapped. */
  onExitToLobby: (() => void) | null = null;

  private pauseOverlay:    PIXI.Container | null = null;
  private gameOverOverlay: PIXI.Container | null = null;

  private timerText!:       PIXI.Text;
  private coinText!:        PIXI.Text;
  private playerHpGfx!:     PIXI.Graphics;
  private enemyHpGfx!:      PIXI.Graphics;
  private upgradeBtnBg!:    PIXI.Graphics;
  private upgradeBtnLabel!: PIXI.Text;
  private settingsBtnBg!:   PIXI.Graphics;

  private readonly layout: ILayout;

  // ── Hit rects (design space) ──────────────────────────────────────────────
  private _settingsRect:    Rect = { x: 0, y: 0, w: 0, h: 0 };
  private _upgradeRect:     Rect = { x: 0, y: 0, w: 0, h: 0 };
  private _pauseResumeRect: Rect | null = null;
  private _pauseExitRect:   Rect | null = null;

  /** True when upgrade is currently affordable (set each frame by sync). */
  upgradeEnabled = false;

  constructor(layout: ILayout) {
    this.container           = new PIXI.Container();
    this.backgroundContainer = new PIXI.Container();
    this.layout              = layout;
    this.build();
  }

  // ── Hit rect accessors ────────────────────────────────────────────────────

  getSettingsRect():    Rect        { return this._settingsRect; }
  getUpgradeRect():     Rect        { return this._upgradeRect; }
  getPauseResumeRect(): Rect | null { return this._pauseResumeRect; }
  getPauseExitRect():   Rect | null { return this._pauseExitRect; }

  // ── Per-frame sync ─────────────────────────────────────────────────────────

  sync(state: GameState): void {
    const p = state.bottomPlayer;
    const e = state.topPlayer;

    this.timerText.text = this.formatTime(state.elapsedTicks / 30);
    this.coinText.text  = `⬤ ${p.coins}`;
    this.drawHpBar(this.playerHpGfx, p.baseHp, BASE_HP);
    this.drawHpBar(this.enemyHpGfx,  e.baseHp, BASE_HP);

    const cost = p.nextUpgradeCost;
    if (cost === null) {
      this.upgradeBtnLabel.text = t('hud.upgradeMax');
      this.upgradeEnabled       = false;
      this.setUpgradeBtnStyle(false);
    } else {
      const canAfford = p.coins >= cost;
      this.upgradeBtnLabel.text = t('hud.upgradeCost', { cost });
      this.upgradeEnabled       = canAfford;
      this.setUpgradeBtnStyle(canAfford);
    }
  }

  // ── Pause overlay ──────────────────────────────────────────────────────────

  showPause(): void {
    if (this.pauseOverlay) return;
    const dw = this.layout.designWidth;
    const dh = this.layout.designHeight;
    const overlay = new PIXI.Container();

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.6);
    dim.drawRect(0, 0, dw, dh);
    dim.endFill();
    overlay.addChild(dim);

    const pW = Math.round(dw * 0.55);
    const pH = Math.round(dh * 0.30);
    const pX = (dw - pW) / 2;
    const pY = (dh - pH) / 2;

    const panel = new PIXI.Graphics();
    panel.beginFill(0xfaf6ee);
    panel.lineStyle(2, 0x333333);
    panel.drawRoundedRect(pX, pY, pW, pH, 8);
    panel.endFill();
    overlay.addChild(panel);

    const title = new PIXI.Text(t('hud.paused'), {
      fontSize: Math.round(pH * 0.18), fill: 0x222222,
      fontWeight: 'bold', fontFamily: 'monospace',
    });
    title.anchor.set(0.5, 0);
    title.x = dw / 2;
    title.y = pY + pH * 0.08;
    overlay.addChild(title);

    const bW = Math.round(pW * 0.72);
    const bH = Math.round(pH * 0.20);
    const gap = Math.round(pH * 0.06);
    const y1  = pY + pH * 0.38;
    const y2  = y1 + bH + gap;
    const bX  = (dw - bW) / 2;

    overlay.addChild(this.makeBtn(bX, y1, bW, bH, 0x2c2c2a, t('hud.resume'),      0xffffff));
    overlay.addChild(this.makeBtn(bX, y2, bW, bH, 0xf0ece0, t('hud.exitToLobby'), 0x444444, 0x888888));

    this._pauseResumeRect = { x: bX, y: y1, w: bW, h: bH };
    this._pauseExitRect   = { x: bX, y: y2, w: bW, h: bH };

    this.container.addChild(overlay);
    this.pauseOverlay = overlay;
  }

  hidePause(): void {
    if (!this.pauseOverlay) return;
    this.container.removeChild(this.pauseOverlay);
    this.pauseOverlay.destroy({ children: true });
    this.pauseOverlay    = null;
    this._pauseResumeRect = null;
    this._pauseExitRect   = null;
  }

  get isPaused(): boolean { return this.pauseOverlay !== null; }

  showGameOver(winner: OwnerId | null): void {
    if (this.gameOverOverlay) return;
    const overlay = new PIXI.Container();
    const bg = new PIXI.Graphics();
    bg.beginFill(0x000000, 0.55);
    bg.drawRoundedRect(-160, -50, 320, 100, 8);
    bg.endFill();
    const msg  = winner === null ? t('hud.draw') : (winner === 0 ? t('hud.win') : t('hud.lose'));
    const text = new PIXI.Text(msg, { fontSize: 38, fill: 0xffffff, fontWeight: 'bold' });
    text.anchor.set(0.5);
    overlay.addChild(bg, text);
    overlay.x = this.layout.designWidth  / 2;
    overlay.y = this.layout.designHeight / 2;
    this.container.addChild(overlay);
    this.gameOverOverlay = overlay;
  }

  // ── Private build ──────────────────────────────────────────────────────────

  private build(): void {
    const { hudTopRect: topR, hudBottomLeftRect: bLR, hudBottomRightRect: bRR } = this.layout;
    const isLandscape = this.layout.orientation === 'landscape';

    // Top strip background
    const topBg = new PIXI.Graphics();
    topBg.beginFill(0xede5d5, 0.92);
    topBg.drawRect(topR.x, topR.y, topR.w, topR.h);
    topBg.endFill();

    // Timer
    this.timerText   = new PIXI.Text('0:00', { ...TEXT_STYLE, fontSize: 16 });
    this.timerText.x = topR.x + 14;
    this.timerText.y = topR.y + (topR.h - this.timerText.height) / 2;

    // Enemy HP bar
    this.enemyHpGfx   = new PIXI.Graphics();
    this.enemyHpGfx.y = topR.y + (topR.h - HP_CELL_H) / 2;
    this.enemyHpGfx.x = isLandscape
      ? topR.x + (topR.w - HP_BAR_W) / 2
      : this.baseCenterX() - HP_BAR_W / 2;

    // Settings button — visual only, no interactive
    this.settingsBtnBg = new PIXI.Graphics();
    const sBtnX = topR.x + topR.w - BTN_W - 8;
    const sBtnY = topR.y + (topR.h - BTN_H) / 2;
    this.settingsBtnBg.x = sBtnX;
    this.settingsBtnBg.y = sBtnY;
    this.drawSettingsBtn();
    this._settingsRect = { x: sBtnX, y: sBtnY, w: BTN_W, h: BTN_H };

    const sLabel = new PIXI.Text('⚙', { fontSize: 18, fill: 0x333333 });
    sLabel.anchor.set(0.5);
    sLabel.x = sBtnX + BTN_W / 2;
    sLabel.y = sBtnY + BTN_H / 2;

    // Bottom strip (full width) — rendered behind the hand cards so it
    // doesn't paint over them (see backgroundContainer wiring in GameRenderer).
    const botBg = new PIXI.Graphics();
    botBg.beginFill(0xede5d5, 0.92);
    botBg.drawRect(0, bLR.y, this.layout.designWidth, bLR.h);
    botBg.endFill();
    this.backgroundContainer.addChild(botBg);

    // Coins
    this.coinText   = new PIXI.Text('⬤ 0', TEXT_STYLE);
    this.coinText.x = bLR.x + 14;

    // Player HP bar
    this.playerHpGfx = new PIXI.Graphics();
    if (isLandscape) {
      this.coinText.y      = bLR.y + bLR.h * 0.22;
      this.playerHpGfx.x   = bLR.x + 14;
      this.playerHpGfx.y   = bLR.y + bLR.h * 0.58;
    } else {
      this.coinText.y      = bLR.y + (bLR.h - this.coinText.height) / 2;
      this.playerHpGfx.x   = this.baseCenterX() - HP_BAR_W / 2;
      this.playerHpGfx.y   = bLR.y + (bLR.h - HP_CELL_H) / 2;
    }

    // Upgrade button — visual only, no interactive
    this.upgradeBtnBg    = new PIXI.Graphics();
    this.upgradeBtnLabel = new PIXI.Text(t('hud.upgradeCost', { cost: BASE_UPGRADE_COSTS[0]! }), SMALL_STYLE);
    const uBtnX = bRR.x + (bRR.w - BTN_W) / 2;
    const uBtnY = bRR.y + (bRR.h - BTN_H) / 2;
    this.upgradeBtnBg.x  = uBtnX;
    this.upgradeBtnBg.y  = uBtnY;
    this.upgradeBtnLabel.anchor.set(0.5);
    this.upgradeBtnLabel.x = uBtnX + BTN_W / 2;
    this.upgradeBtnLabel.y = uBtnY + BTN_H / 2;
    this._upgradeRect      = { x: uBtnX, y: uBtnY, w: BTN_W, h: BTN_H };
    this.setUpgradeBtnStyle(false);

    this.container.addChild(
      topBg, this.timerText, this.enemyHpGfx, this.settingsBtnBg, sLabel,
      this.coinText,  this.playerHpGfx,
      this.upgradeBtnBg, this.upgradeBtnLabel,
    );
  }

  private baseCenterX(): number {
    const r = this.layout.playerBaseRect();
    return r.x + r.w / 2;
  }

  private makeBtn(
    x: number, y: number, w: number, h: number,
    bgColor: number, label: string, textColor: number, borderColor = 0x333333,
  ): PIXI.Container {
    const c = new PIXI.Container();
    const bg = new PIXI.Graphics();
    bg.beginFill(bgColor);
    bg.lineStyle(1, borderColor);
    bg.drawRoundedRect(0, 0, w, h, 6);
    bg.endFill();
    const txt = new PIXI.Text(label, {
      fontSize: Math.round(h * 0.42), fill: textColor, fontWeight: 'bold', fontFamily: 'monospace',
    });
    txt.anchor.set(0.5, 0.5);
    txt.x = w / 2; txt.y = h / 2;
    c.addChild(bg, txt);
    c.x = x; c.y = y;
    return c;
  }

  private drawHpBar(gfx: PIXI.Graphics, hp: number, maxHp: number): void {
    gfx.clear();
    const filled = Math.ceil((hp / maxHp) * HP_CELLS);
    for (let i = 0; i < HP_CELLS; i++) {
      const f = i < filled;
      const d = filled <= 3;
      gfx.beginFill(f ? (d ? 0xcc3333 : 0x333333) : 0xdddddd, f ? 0.85 : 0.5);
      gfx.lineStyle(1, 0x888888, 0.4);
      gfx.drawRect(i * (HP_CELL_W + HP_CELL_GAP), 0, HP_CELL_W, HP_CELL_H);
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

  private setUpgradeBtnStyle(enabled: boolean): void {
    this.upgradeBtnBg.clear();
    this.upgradeBtnBg.beginFill(enabled ? 0x2c2c2a : 0x999999);
    this.upgradeBtnBg.lineStyle(1, 0x333333);
    this.upgradeBtnBg.drawRoundedRect(0, 0, BTN_W, BTN_H, 4);
    this.upgradeBtnBg.endFill();
    this.upgradeBtnLabel.style.fill = enabled ? 0xffffff : 0xdddddd;
  }

  private formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
