import * as PIXI from 'pixi.js-legacy';
import { makeText } from './pixiText';
import { BASE_HP, BASE_UPGRADE_COSTS, HAND_REFRESH_COST } from '../game/config';
import { GameState } from '../game/GameState';
import { OwnerId } from '../game/types';
import { ILayout, Rect } from '../layout/ILayout';
import { t } from '../i18n';
import { getLabelTexture } from './labelDecor';
import { drawHudButton, hudButtonText, HudButtonVariant } from './hudButton';
import { FS, snapFont } from './fontScale';
import { factionInk, fx } from './theme';
import { drawInk } from './icons/currency';

// ── Constants ─────────────────────────────────────────────────────────────────

const TEXT_STYLE  = { fontSize: FS.tiny, fill: 0x222222, fontFamily: 'monospace' } as const;
const SMALL_STYLE = { fontSize: FS.micro, fill: 0x555555, fontFamily: 'monospace' } as const;
// Surrender button — top strip. Taller than the old 30 so it's an easier tap target.
const BTN_W       = 100;
const BTN_H       = 44;
/** Ink-well glyph box (design px) drawn left of the ink count. */
const INK_ICON_S  = 28;
// Bottom action buttons (upgrade / refresh) — larger, laid out inside hudBottomRightRect.
const ACTION_LABEL_STYLE = { fontSize: FS.title, fill: 0x555555, fontFamily: 'monospace', fontWeight: 'bold' } as const;

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

  private surrenderOverlay: PIXI.Container | null = null;
  private gameOverOverlay: PIXI.Container | null = null;

  private timerText!:       PIXI.Text;
  private inkText!:         PIXI.Text;
  private inkIcon!:         PIXI.Graphics;
  private playerHpGfx!:     PIXI.Graphics;
  private enemyHpGfx!:      PIXI.Graphics;
  private upgradeBtnBg!:    PIXI.Graphics;
  private upgradeBtnLabel!: PIXI.Text;
  private upgradeGlow!:     PIXI.Graphics;
  private upgradeArrow!:    PIXI.Text;
  private refreshBtnBg!:    PIXI.Graphics;
  private refreshBtnLabel!: PIXI.Text;
  private surrenderBtnBg!:  PIXI.Graphics;

  /** Monotonic phase driver for HP-danger blink + upgrade-affordable pulse. */
  private pulseT = 0;

  /** Pixel size of the bottom action buttons (set in build, per orientation). */
  private actionBtnW = 0;
  private actionBtnH = 0;

  private readonly layout: ILayout;

  // ── Hit rects (design space) ──────────────────────────────────────────────
  private _surrenderRect:        Rect = { x: 0, y: 0, w: 0, h: 0 };
  private _upgradeRect:          Rect = { x: 0, y: 0, w: 0, h: 0 };
  private _refreshRect:          Rect = { x: 0, y: 0, w: 0, h: 0 };
  private _surrenderCancelRect:  Rect | null = null;
  private _surrenderConfirmRect: Rect | null = null;
  /** Opponent info area (top strip, left of the settings button) — profile tap (S1 net). */
  private _enemyInfoRect:   Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Local player info area (bottom strip, left) — profile tap (S1 net). */
  private _playerInfoRect:  Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Enemy HP bar (top strip, board-centered) — the opponent name button anchors to its left. */
  private _enemyHpRect:     Rect = { x: 0, y: 0, w: 0, h: 0 };

  /** True when upgrade is currently affordable (set each frame by sync). */
  upgradeEnabled = false;
  /** True when hand-refresh is currently affordable (set each frame by sync). */
  refreshEnabled = false;

  /** Campaign (PvE) levels reword the surrender button/dialog as "exit level". */
  private readonly campaign: boolean;

  /** Replay/spectator playback hides the surrender button entirely (nothing to surrender). */
  private readonly hideSurrender: boolean;

  constructor(layout: ILayout, campaign = false, hideSurrender = false) {
    this.container           = new PIXI.Container();
    this.backgroundContainer = new PIXI.Container();
    this.layout              = layout;
    this.campaign            = campaign;
    this.hideSurrender       = hideSurrender;
    this.build();
  }

  // ── Hit rect accessors ────────────────────────────────────────────────────

  getSurrenderRect():        Rect        { return this._surrenderRect; }
  getUpgradeRect():          Rect        { return this._upgradeRect; }
  getRefreshRect():          Rect        { return this._refreshRect; }
  getSurrenderCancelRect():  Rect | null { return this._surrenderCancelRect; }
  getSurrenderConfirmRect(): Rect | null { return this._surrenderConfirmRect; }
  getEnemyInfoRect():        Rect        { return this._enemyInfoRect; }
  getPlayerInfoRect():       Rect        { return this._playerInfoRect; }
  getEnemyHpRect():          Rect        { return this._enemyHpRect; }
  /** Tighten the opponent profile-tap region to the name button (set by GameRenderer). */
  setEnemyInfoRect(r: Rect): void        { this._enemyInfoRect = r; }

  // ── Per-frame sync ─────────────────────────────────────────────────────────

  sync(state: GameState, localOwner: OwnerId = 0): void {
    // Bottom strip always shows the *local* player; top strip the opponent.
    // For the netplay joiner (localOwner 1) that means top↔bottom are swapped
    // relative to the raw owner indices.
    const p = localOwner === 0 ? state.bottomPlayer : state.topPlayer;
    const e = localOwner === 0 ? state.topPlayer    : state.bottomPlayer;

    // Danger blink / affordable pulse phases: 0..1 sinusoids. `pulse` (~0.7s) drives
    // the gentle low-HP throb + upgrade glow; `pulseFast` (~0.3s) drives the urgent
    // critical-HP blink + ⚠. Deterministic enough without a real clock (sync runs per frame).
    this.pulseT += 0.15;
    const pulse     = 0.5 + 0.5 * Math.sin(this.pulseT);
    const pulseFast = 0.5 + 0.5 * Math.sin(this.pulseT * 2.3);

    this.timerText.text = this.formatTime(state.elapsedTicks / 30);
    this.inkText.text   = `${p.ink}`;
    this.positionInkIcon();
    // Faction hue is fixed (us = blue, enemy = red); "low HP" is signalled by the
    // bar blinking, NOT by turning red — otherwise our own low-HP warning would
    // collide with the enemy's red. Critical (last cell) escalates to a fast blink
    // plus an amber ⚠. See drawHpBar.
    this.drawHpBar(this.playerHpGfx, p.baseHp, BASE_HP, factionInk.friend, pulse, pulseFast);
    this.drawHpBar(this.enemyHpGfx,  e.baseHp, BASE_HP, factionInk.enemy,  pulse, pulseFast);

    const cost = p.nextUpgradeCost;
    if (cost === null) {
      this.upgradeBtnLabel.text = t('hud.upgradeMax');
      this.upgradeEnabled       = false;
      this.setUpgradeBtnStyle(false);
    } else {
      const canAfford = p.ink >= cost;
      this.upgradeBtnLabel.text = t('hud.upgradeCost', { cost });
      this.upgradeEnabled       = canAfford;
      this.setUpgradeBtnStyle(canAfford);
    }
    this.animateUpgradeFx(pulse);

    const canRefresh = p.ink >= HAND_REFRESH_COST;
    this.refreshEnabled = canRefresh;
    this.setRefreshBtnStyle(canRefresh);
  }

  /** Place the ink glyph just left of the (variable-width) ink count, both orientations. */
  private positionInkIcon(): void {
    const numLeft = this.inkText.anchor.x === 1
      ? this.inkText.x - this.inkText.width   // landscape: right-anchored count
      : this.inkText.x;                        // portrait: left-anchored count
    this.inkIcon.x = numLeft - 8 - INK_ICON_S;
    this.inkIcon.y = this.inkText.y + (this.inkText.height - INK_ICON_S) / 2;
  }

  /**
   * Upgrade-affordable attention FX (§5): a marker-yellow glow ring that breathes
   * around the button plus a small chevron bobbing above it. Hidden unless the
   * upgrade is currently affordable — the button itself also flips to `primary`.
   */
  private animateUpgradeFx(pulse: number): void {
    if (!this.upgradeEnabled) {
      this.upgradeGlow.visible  = false;
      this.upgradeArrow.visible = false;
      return;
    }
    const r = this._upgradeRect;
    const grow = 3 + 4 * pulse;
    this.upgradeGlow.visible = true;
    this.upgradeGlow.clear();
    this.upgradeGlow.lineStyle(3, fx.upgrade, 0.35 + 0.5 * pulse);
    this.upgradeGlow.drawRoundedRect(r.x - grow, r.y - grow, r.w + grow * 2, r.h + grow * 2, 8);

    this.upgradeArrow.visible = true;
    this.upgradeArrow.y = r.y - this.upgradeArrow.height - 2 - 4 * pulse; // bob toward the button
    this.upgradeArrow.alpha = 0.55 + 0.45 * pulse;
  }

  // ── Surrender confirmation overlay ────────────────────────────────────────

  showSurrenderConfirm(): void {
    if (this.surrenderOverlay) return;
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

    const title = makeText(t(this.campaign ? 'hud.exitLevelTitle' : 'hud.surrenderTitle'), {
      fontSize: snapFont(Math.round(pH * 0.18)), fill: 0x222222,
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

    overlay.addChild(this.makeBtn(bX, y1, bW, bH, 'secondary', t('hud.surrenderCancel')));
    overlay.addChild(this.makeBtn(bX, y2, bW, bH, 'primary',   t(this.campaign ? 'hud.exitLevelConfirm' : 'hud.surrenderConfirm')));

    this._surrenderCancelRect  = { x: bX, y: y1, w: bW, h: bH };
    this._surrenderConfirmRect = { x: bX, y: y2, w: bW, h: bH };

    this.container.addChild(overlay);
    this.surrenderOverlay = overlay;
  }

  hideSurrenderConfirm(): void {
    if (!this.surrenderOverlay) return;
    this.container.removeChild(this.surrenderOverlay);
    this.surrenderOverlay.destroy({ children: true });
    this.surrenderOverlay      = null;
    this._surrenderCancelRect  = null;
    this._surrenderConfirmRect = null;
  }

  get isPaused(): boolean { return this.surrenderOverlay !== null; }

  showGameOver(winner: OwnerId | null, localOwner: OwnerId = 0): void {
    if (this.gameOverOverlay) return;
    const overlay = new PIXI.Container();
    const bg = new PIXI.Graphics();
    bg.beginFill(0x000000, 0.55);
    bg.drawRoundedRect(-160, -50, 320, 100, 8);
    bg.endFill();
    const msg  = winner === null ? t('hud.draw') : (winner === localOwner ? t('hud.win') : t('hud.lose'));
    const text = makeText(msg, { fontSize: FS.headline, fill: 0xffffff, fontWeight: 'bold' });
    text.anchor.set(0.5);
    overlay.addChild(bg, text);

    // Hand-drawn `WIN!` flourish above the box on a local victory (art-direction
    // §6.2 group B). Cosmetic — skipped silently if the label PNG hasn't loaded.
    if (winner === localOwner) {
      const winTex = getLabelTexture('label_win');
      if (winTex) {
        const win = new PIXI.Sprite(winTex);
        win.anchor.set(0.5);
        win.scale.set(Math.min(200 / winTex.width, 96 / winTex.height));
        win.rotation = -0.06;
        win.y = -50 - win.height / 2 - 12;
        overlay.addChild(win);
      }
    }
    overlay.x = this.layout.designWidth  / 2;
    overlay.y = this.layout.designHeight / 2;
    this.container.addChild(overlay);
    this.gameOverOverlay = overlay;
  }

  // ── Private build ──────────────────────────────────────────────────────────

  private build(): void {
    const { hudTopRect: topR, hudBottomLeftRect: bLR, hudBottomRightRect: bRR, boardRect: board } = this.layout;
    const isLandscape = this.layout.orientation === 'landscape';
    // In landscape the design space can be far wider than the centered board, so
    // top-strip elements anchor to the board's horizontal extent (its left edge,
    // center, and right edge) instead of the design edges — keeping the timer,
    // enemy HP bar, and surrender button locked to the board like the bottom
    // strip. Portrait keeps its own full-width top-strip anchoring.
    const boardLeft  = board.x;
    const boardRight = board.x + board.w;

    // Top strip background
    const topBg = new PIXI.Graphics();
    topBg.beginFill(0xede5d5, 0.92);
    topBg.drawRect(topR.x, topR.y, topR.w, topR.h);
    topBg.endFill();

    // Timer — landscape hugs the board's left edge; portrait keeps the strip edge.
    this.timerText   = makeText('0:00', { ...TEXT_STYLE, fontSize: FS.title });
    this.timerText.x = (isLandscape ? boardLeft : topR.x) + 14;
    this.timerText.y = topR.y + (topR.h - this.timerText.height) / 2;

    // Enemy HP bar — centered over the board (landscape) or the enemy base (portrait).
    this.enemyHpGfx   = new PIXI.Graphics();
    this.enemyHpGfx.y = topR.y + (topR.h - HP_CELL_H) / 2;
    this.enemyHpGfx.x = isLandscape
      ? boardLeft + (board.w - HP_BAR_W) / 2
      : this.baseCenterX() - HP_BAR_W / 2;
    this._enemyHpRect = { x: this.enemyHpGfx.x, y: this.enemyHpGfx.y, w: HP_BAR_W, h: HP_CELL_H };

    // Surrender button — visual only, no interactive. Landscape hugs the board's
    // right edge; portrait keeps the strip edge. Hidden entirely during replay
    // playback (spectator): there is nothing to surrender, and `_surrenderRect`
    // stays zero so input hit-testing never triggers the confirm dialog.
    this.surrenderBtnBg = new PIXI.Graphics();
    const sBtnX = (isLandscape ? boardRight : topR.x + topR.w) - BTN_W - 8;
    const sBtnY = topR.y + (topR.h - BTN_H) / 2;
    let sLabel: PIXI.Text | null = null;
    if (!this.hideSurrender) {
      this.surrenderBtnBg.x = sBtnX;
      this.surrenderBtnBg.y = sBtnY;
      this.drawSurrenderBtn();
      this._surrenderRect = { x: sBtnX, y: sBtnY, w: BTN_W, h: BTN_H };

      sLabel = makeText(t(this.campaign ? 'hud.exitLevel' : 'hud.surrender'), { fontSize: FS.small, fill: 0x333333, fontWeight: 'bold', fontFamily: 'monospace' });
      sLabel.anchor.set(0.5);
      sLabel.x = sBtnX + BTN_W / 2;
      sLabel.y = sBtnY + BTN_H / 2;
    }

    // Bottom strip (full width) — rendered behind the hand cards so it
    // doesn't paint over them (see backgroundContainer wiring in GameRenderer).
    const botBg = new PIXI.Graphics();
    botBg.beginFill(0xede5d5, 0.92);
    botBg.drawRect(0, bLR.y, this.layout.designWidth, bLR.h);
    botBg.endFill();
    this.backgroundContainer.addChild(botBg);

    // Ink — a dedicated ink-well glyph (our faction blue) followed by the count.
    // The glyph is positioned each frame by positionInkIcon (count width varies).
    this.inkText = makeText('0', { ...TEXT_STYLE, fontSize: FS.title });
    this.inkIcon = new PIXI.Graphics();
    drawInk(this.inkIcon, INK_ICON_S, factionInk.friend);

    // Player HP bar
    this.playerHpGfx = new PIXI.Graphics();
    if (isLandscape) {
      // Right-anchored within the column (its inner edge, bordering the hand
      // strip) rather than the column's outer/screen edge — the column itself
      // already moves inward via `inset` above, but that's wasted unless the
      // content inside it hugs the near side instead of the far side.
      this.inkText.anchor.set(1, 0);
      this.inkText.x       = bLR.x + bLR.w - 14;
      this.inkText.y       = bLR.y + bLR.h * 0.22;
      this.playerHpGfx.x   = bLR.x + bLR.w - HP_BAR_W - 14;
      this.playerHpGfx.y   = bLR.y + bLR.h * 0.58;
    } else {
      // Shift the count right to leave room for the glyph at the strip's left edge.
      this.inkText.x       = bLR.x + 14 + INK_ICON_S + 8;
      this.inkText.y       = bLR.y + (bLR.h - this.inkText.height) / 2;
      this.playerHpGfx.x   = this.baseCenterX() - HP_BAR_W / 2;
      this.playerHpGfx.y   = bLR.y + (bLR.h - HP_CELL_H) / 2;
    }

    // Bottom action buttons (refresh + upgrade) — larger than the surrender button,
    // laid out inside the bottom-right rect. Portrait: side by side (wide, short
    // rect); landscape: stacked (narrow, tall rect).
    const MARGIN = 12;
    const GAP    = 14;
    let rRefresh: Rect;
    let rUpgrade: Rect;
    if (isLandscape) {
      const bw = bRR.w - MARGIN * 2;
      const bh = Math.round((bRR.h - MARGIN * 2 - GAP) / 2);
      const bx = bRR.x + MARGIN;
      rRefresh = { x: bx, y: bRR.y + MARGIN,           w: bw, h: bh };
      rUpgrade = { x: bx, y: bRR.y + MARGIN + bh + GAP, w: bw, h: bh };
    } else {
      const bw = Math.round((bRR.w - MARGIN * 2 - GAP) / 2);
      const bh = bRR.h - MARGIN * 2;
      const by = bRR.y + MARGIN;
      rRefresh = { x: bRR.x + MARGIN,           y: by, w: bw, h: bh };
      rUpgrade = { x: bRR.x + MARGIN + bw + GAP, y: by, w: bw, h: bh };
    }
    this.actionBtnW = rRefresh.w;
    this.actionBtnH = rRefresh.h;

    // Refresh button — visual only, no interactive
    this.refreshBtnBg    = new PIXI.Graphics();
    this.refreshBtnLabel = makeText(t('hud.refreshCost', { cost: HAND_REFRESH_COST }), ACTION_LABEL_STYLE);
    this.refreshBtnBg.x  = rRefresh.x;
    this.refreshBtnBg.y  = rRefresh.y;
    this.refreshBtnLabel.anchor.set(0.5);
    this.refreshBtnLabel.x = rRefresh.x + rRefresh.w / 2;
    this.refreshBtnLabel.y = rRefresh.y + rRefresh.h / 2;
    this._refreshRect      = rRefresh;
    this.setRefreshBtnStyle(false);

    // Upgrade button — visual only, no interactive
    this.upgradeBtnBg    = new PIXI.Graphics();
    this.upgradeBtnLabel = makeText(t('hud.upgradeCost', { cost: BASE_UPGRADE_COSTS[0]! }), ACTION_LABEL_STYLE);
    this.upgradeBtnBg.x  = rUpgrade.x;
    this.upgradeBtnBg.y  = rUpgrade.y;
    this.upgradeBtnLabel.anchor.set(0.5);
    this.upgradeBtnLabel.x = rUpgrade.x + rUpgrade.w / 2;
    this.upgradeBtnLabel.y = rUpgrade.y + rUpgrade.h / 2;
    this._upgradeRect      = rUpgrade;
    this.setUpgradeBtnStyle(false);

    // Upgrade attention FX (§5): breathing glow ring (behind the button) + a bobbing
    // chevron above it. Both hidden until the upgrade is affordable (animateUpgradeFx).
    this.upgradeGlow = new PIXI.Graphics();
    this.upgradeGlow.visible = false;
    this.upgradeArrow = makeText('▼', {
      fontSize: snapFont(Math.round(rUpgrade.h * 0.5)), fill: fx.upgrade, fontWeight: 'bold', fontFamily: 'monospace',
    });
    this.upgradeArrow.anchor.set(0.5, 0);
    this.upgradeArrow.x = rUpgrade.x + rUpgrade.w / 2;
    this.upgradeArrow.y = rUpgrade.y - this.upgradeArrow.height - 2;
    this.upgradeArrow.visible = false;

    // Profile-tap regions (used only in netplay, GameRenderer gates on netEnabled):
    // opponent = top strip up to the surrender button; local = bottom-left info column.
    this._enemyInfoRect  = { x: topR.x, y: topR.y, w: Math.max(0, sBtnX - topR.x), h: topR.h };
    this._playerInfoRect = { x: bLR.x, y: bLR.y, w: Math.round(this.layout.designWidth * 0.34), h: bLR.h };

    this.container.addChild(
      topBg, this.timerText, this.enemyHpGfx, this.surrenderBtnBg,
      this.inkIcon, this.inkText, this.playerHpGfx,
      this.refreshBtnBg, this.refreshBtnLabel,
      this.upgradeGlow,                        // behind the upgrade button
      this.upgradeBtnBg, this.upgradeBtnLabel,
      this.upgradeArrow,                       // above the upgrade button
    );
    if (sLabel) this.container.addChild(sLabel);
  }

  private baseCenterX(): number {
    const r = this.layout.playerBaseRect();
    return r.x + r.w / 2;
  }

  private makeBtn(
    x: number, y: number, w: number, h: number,
    variant: HudButtonVariant, label: string,
  ): PIXI.Container {
    const c = new PIXI.Container();
    const bg = new PIXI.Graphics();
    drawHudButton(bg, w, h, variant, { radius: 6 });
    const txt = makeText(label, {
      fontSize: snapFont(Math.round(h * 0.42)), fill: hudButtonText(variant), fontWeight: 'bold', fontFamily: 'monospace',
    });
    txt.anchor.set(0.5, 0.5);
    txt.x = w / 2; txt.y = h / 2;
    c.addChild(bg, txt);
    c.x = x; c.y = y;
    return c;
  }

  /**
   * HP bar in the faction hue (us = blue, enemy = red). Danger is signalled by the
   * filled cells *blinking* (alpha throb) — never by changing hue — so our low-HP
   * alarm can't be mistaken for the enemy's red. Two tiers:
   *   low      (≤3 cells): gentle blink on `pulse`.
   *   critical (last cell): urgent fast blink on `pulseFast` + an amber ⚠ above the
   *     bar. The last cell is the "one haste-rush from over" moment for BOTH bases,
   *     so the enemy bar escalates too (it also gets a base-ring on the board).
   */
  private drawHpBar(
    gfx: PIXI.Graphics, hp: number, maxHp: number, color: number, pulse: number, pulseFast: number,
  ): void {
    gfx.clear();
    const filled   = Math.ceil((hp / maxHp) * HP_CELLS);
    const critical = hp > 0 && filled <= 1;
    const low      = hp > 0 && filled <= 3 && !critical;
    const fillAlpha = critical ? 0.25 + 0.75 * pulseFast : low ? 0.35 + 0.6 * pulse : 0.9;
    for (let i = 0; i < HP_CELLS; i++) {
      const f = i < filled;
      gfx.beginFill(f ? color : 0xdddddd, f ? fillAlpha : 0.4);
      gfx.lineStyle(1, 0x888888, 0.4);
      gfx.drawRect(i * (HP_CELL_W + HP_CELL_GAP), 0, HP_CELL_W, HP_CELL_H);
      gfx.endFill();
    }
    if (critical) this.drawHpWarning(gfx, pulseFast);
  }

  /** Amber ⚠ centred above the bar, blinking on `pulseFast` — the critical-HP alarm. */
  private drawHpWarning(gfx: PIXI.Graphics, pulseFast: number): void {
    const cx = HP_BAR_W / 2;
    const tw = 16, th = 13, topY = -th - 4;
    const a = 0.4 + 0.6 * pulseFast;
    gfx.beginFill(0xffb300, a);
    gfx.moveTo(cx, topY);
    gfx.lineTo(cx - tw / 2, topY + th);
    gfx.lineTo(cx + tw / 2, topY + th);
    gfx.closePath();
    gfx.endFill();
    gfx.beginFill(0x4a3200, a); // the "!" inside
    gfx.drawRect(cx - 1, topY + 3, 2, th - 7);
    gfx.drawRect(cx - 1, topY + th - 3, 2, 2);
    gfx.endFill();
  }

  private drawSurrenderBtn(): void {
    this.surrenderBtnBg.clear();
    drawHudButton(this.surrenderBtnBg, BTN_W, BTN_H, 'secondary', { radius: 4 });
  }

  private setUpgradeBtnStyle(enabled: boolean): void {
    const variant: HudButtonVariant = enabled ? 'primary' : 'disabled';
    this.upgradeBtnBg.clear();
    drawHudButton(this.upgradeBtnBg, this.actionBtnW, this.actionBtnH, variant, { radius: 6 });
    this.upgradeBtnLabel.style.fill = hudButtonText(variant);
  }

  private setRefreshBtnStyle(enabled: boolean): void {
    const variant: HudButtonVariant = enabled ? 'accent' : 'disabled';
    this.refreshBtnBg.clear();
    drawHudButton(this.refreshBtnBg, this.actionBtnW, this.actionBtnH, variant, { radius: 6 });
    this.refreshBtnLabel.style.fill = hudButtonText(variant);
  }

  private formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
