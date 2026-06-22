import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { SketchPen } from '../render/sketch';
import { palette } from '../render/theme';
import { bake } from '../render/bake';
import { buildWearOverlay } from '../render/wearOverlay';
import { BoilingSprite } from '../render/boil';
import { buildAvatar } from '../render/avatar';

// ── AI name pool ───────────────────────────────────────────────────────────────

const AI_NAMES = [
  'Scribble', 'Doodler', 'InkMaster', 'PencilWarrior', 'Eraserhead',
  'LoopyLines', 'SketchBot', 'NoteSlayer', 'RuledPage', 'BlotterKing',
  'QuillStrike', 'MarginNotes', 'CrayonCrusher', 'GraphiteFist', 'InkWell',
];

function randomAiName(): string {
  return AI_NAMES[Math.floor(Math.random() * AI_NAMES.length)]!;
}

const C = {
  bg:     0xf5f0e8,
  paper:  0xfaf6ee,
  dark:   0x2c2c2a,
  mid:    0x888888,
  light:  0xdddddd,
  btnOff: 0xbbbbbb,
  accent: 0x4477cc,
  gold:   0xcc9900,
  green:  0x4a9e4a,
  red:    0xcc3333,
};

function txt(label: string, size: number, color: number, bold = false): PIXI.Text {
  return new PIXI.Text(label, {
    fontSize: size, fill: color, fontFamily: 'monospace',
    fontWeight: bold ? 'bold' : 'normal',
  });
}

// ── LobbyScene ────────────────────────────────────────────────────────────────

export interface LobbySceneCallbacks {
  onStartGame(opponentName: string): void;
  /**
   * Enter real PvP ranked matchmaking (online). Only invoked when `online` is
   * true; otherwise the start button falls back to the local AI match.
   */
  onStartRanked?(): void;
  /** True when logged in + an online server is configured → match = real PvP. */
  online?: boolean;
  /** Enter the campaign notebook (CampaignMapScene) — the single PvE front door. */
  onOpenCampaign(): void;
  /** Open the friend room (online play). Used by the social hub's "play online" button. */
  onOpenRoom(): void;
  /**
   * Open the social hub (friends / requests). Wired to the bottom-nav "social"
   * slot (S6-1). Falls back to onOpenRoom when not provided (older callers).
   */
  onOpenSocial?(): void;
  /** Open the SLG world map. Wired to the bottom-nav "home/world" slot (S8). */
  onOpenWorld?(): void;
  /** Open the shop (economy). Wired to the bottom-nav "shop" slot (S2-6). */
  onOpenShop(): void;
  /** Open the collection center (cards codex + skins). Bottom-nav "cards" slot. */
  onOpenCards(): void;
  /** Open the stats / match-record screen. Bottom-nav "stats" slot. */
  onOpenStats(): void;
  /**
   * Jump straight to the achievement wall. Wired only when online; invoked when the
   * player taps an "achievement unlocked" toast (ACHIEVEMENT_DESIGN §7, S9-5b).
   */
  onOpenAchievements?(): void;
  /** Open the daily check-in + task screen (B5, RETENTION_DESIGN). */
  onOpenDaily?(): void;
  /** Open the personal profile / settings screen (top-left profile chip). */
  onOpenProfile(): void;
  /** Player display name shown in the top-left profile chip. */
  playerName: string;
  /** Server-authoritative ladder standing (SaveData.pvp); shown as a header badge. */
  pvp?: { rank: string; elo: number };
  /** SA-4: offline single-player mode — online entries route to login instead. */
  offline?: boolean;
  /** Open the login screen (offline mode header chip + gated online entries). */
  onLogin?(): void;
  /** Log out (clear persisted session) — shown when logged in. */
  onLogout?(): void;
}

type LobbyState = 'idle' | 'matching' | 'vs';

export class LobbyScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: LobbySceneCallbacks;

  private state:        LobbyState = 'idle';
  private matchTimer    = 0;
  private vsTimer       = 0;
  private dotsTimer     = 0;
  private dotCount      = 0;
  private opponentName  = '';

  private btnBg!:    PIXI.Graphics;
  private btnLabel!: PIXI.Text;
  private vsLayer!:  PIXI.Container;
  private oppLabel!: PIXI.Text;
  /** Boiling-line title underline (art-direction §5.4); cleaned up in destroy. */
  private titleBoil: BoilingSprite | null = null;

  /** Hit rect for the start/matching button, in design space. */
  private btnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the single campaign (PvE) entry button, in design space. */
  private campaignBtnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the bottom-nav "world" slot (opens WorldMapScene). */
  private worldNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the bottom-nav "social" slot (opens RoomScene). */
  private socialNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the bottom-nav "shop" slot (opens ShopScene). */
  private shopNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the bottom-nav "cards" slot (opens CollectionScene). */
  private cardsNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the bottom-nav "stats" slot (opens StatsScene). */
  private statsNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the top-right account chip (login when offline / logout when on). */
  private accountChipRect: Rect | null = null;
  private accountChipFn: (() => void) | null = null;
  /** Hit rect for the top-left profile chip (opens SettingsScene). */
  private profileChipRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  /** Aggregate social unread (friends + chat + mail) → red dot on the social nav slot. */
  private socialBadge = 0;
  /** Re-drawn layer for the social badge so updates don't rebuild the whole nav bar. */
  private socialBadgeLayer: PIXI.Container | null = null;
  /** Any achievement tier is claimable (ACHIEVEMENT_DESIGN §4.1) → red dot on the stats nav slot. */
  private achievementBadge = false;
  /** Re-drawn layer for the achievement dot (cheap refresh, no nav rebuild). */
  private achievementBadgeLayer: PIXI.Container | null = null;
  /** Retention claimable (B5: checkin or daily reward) → red dot on the daily button. */
  private retentionBadge = false;
  /** Hit rect for the daily button (top-right area). */
  private dailyBtnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** null = not yet checked; true = reachable; false = unreachable → show badge. */
  private worldOnline: boolean | null = null;
  /** Cheap-refresh layer for the worldsvc-offline indicator on the world nav slot. */
  private worldOfflineBadgeLayer: PIXI.Container | null = null;
  /** Transient "achievement unlocked" toast (S9-5b): own top-most layer + auto-fade timer + tap-to-open rect. */
  private toastLayer: PIXI.Container | null = null;
  private toastTimer = 0;
  private toastRect: Rect | null = null;
  /** Season-settlement modal overlay (SE-6). Blocks lobby taps until dismissed. */
  private settlementLayer: PIXI.Container | null = null;
  private settlementDismissRect: Rect | null = null;
  /** Set on destroy so a late-resolving badge fetch skips touching a dead container. */
  private destroyed = false;

  private readonly unsubs: Array<() => void> = [];

  constructor(layout: ILayout, input: InputManager, cb: LobbySceneCallbacks) {
    this.container = new PIXI.Container();
    this.w  = layout.designWidth;
    this.h  = layout.designHeight;
    this.cb = cb;
    this.build();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
  }

  // ── Scene interface ────────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.state === 'matching') {
      this.matchTimer += dt;
      this.dotsTimer  += dt;
      if (this.dotsTimer >= 0.4) {
        this.dotsTimer = 0;
        this.dotCount  = (this.dotCount + 1) % 4;
        this.btnLabel.text = t('lobby.matching') + '.'.repeat(this.dotCount);
      }
      if (this.matchTimer >= 1.8) this.matchFound();
    } else if (this.state === 'vs') {
      this.vsTimer += dt;
      if (this.vsTimer >= 2.5) this.cb.onStartGame(this.opponentName);
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.clearToast();
      else if (this.toastLayer) this.toastLayer.alpha = Math.min(1, this.toastTimer / 0.4);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach(u => u());
    this.titleBoil?.destroy();
    this.titleBoil = null;
    this.socialBadgeLayer = null;
    this.achievementBadgeLayer = null;
    this.toastLayer = null;
    this.toastRect = null;
    this.settlementLayer = null;
    this.settlementDismissRect = null;
  }

  /**
   * Update the aggregate social unread count (friends requests + unread chats +
   * unread mail). The core fetches GET /social/badges on lobby entry and forwards
   * push-driven increments here; we redraw just the badge dot, not the nav bar.
   */
  applySocialBadge(total: number): void {
    if (this.destroyed) return;
    this.socialBadge = Math.max(0, total | 0);
    this.drawSocialBadge();
  }

  /**
   * Mark whether any achievement tier is claimable. The core fetches
   * GET /achievements on lobby entry and computes hasClaimable; we redraw just
   * the dot on the stats nav slot, not the nav bar.
   */
  applyAchievementBadge(claimable: boolean): void {
    if (this.destroyed) return;
    this.achievementBadge = claimable;
    this.drawAchievementBadge();
  }

  /** B5: mark whether any retention reward is claimable → red dot on the daily button. */
  applyRetentionBadge(claimable: boolean): void {
    if (this.destroyed) return;
    if (this.retentionBadge === claimable) return;
    this.retentionBadge = claimable;
    // Full rebuild needed since the daily button is part of the main layout.
    this.container.removeChildren();
    this.toastLayer = null;
    this.settlementLayer = null;
    this.achievementBadgeLayer = null;
    this.socialBadgeLayer = null;
    this.titleBoil = null;
    this.build();
  }

  /**
   * Show a transient "achievement unlocked" toast banner (ACHIEVEMENT_DESIGN §7, S9-5b).
   * The core computes the unlock delta after a stats refresh and passes one aggregated
   * message (never one-per-tier); tapping the banner routes to the achievement wall.
   */
  showAchievementToast(text: string): void {
    if (this.destroyed || !text) return;
    this.toastTimer = 4.0;
    this.drawAchievementToast(text);
  }

  private clearToast(): void {
    this.toastTimer = 0;
    this.toastRect = null;
    if (this.toastLayer) { this.toastLayer.destroy({ children: true }); this.toastLayer = null; }
  }

  /** Show season-settlement modal (SE-6). Called once per season transition by the core. */
  showSeasonSettlement(oldNo: number, peakRank: string, newNo: number): void {
    if (this.destroyed || this.settlementLayer) return;
    const { w, h } = this;
    const layer = new PIXI.Container();

    // Dim backdrop
    const backdrop = new PIXI.Graphics();
    backdrop.beginFill(0x000000, 0.6).drawRect(0, 0, w, h).endFill();
    layer.addChild(backdrop);

    // Card
    const cw = Math.round(w * 0.78);
    const ch = Math.round(h * 0.44);
    const cx = (w - cw) / 2;
    const cy = (h - ch) / 2;
    const card = new PIXI.Graphics();
    card.lineStyle(2, C.gold, 1);
    card.beginFill(C.paper).drawRoundedRect(cx, cy, cw, ch, 12).endFill();
    layer.addChild(card);

    const titleLbl = txt(t('season.settlement.title', { no: String(oldNo) }), Math.round(ch * 0.13), C.dark, true);
    titleLbl.anchor.set(0.5, 0); titleLbl.x = w / 2; titleLbl.y = cy + Math.round(ch * 0.08);
    layer.addChild(titleLbl);

    const peakLbl = txt(t('season.settlement.peak'), Math.round(ch * 0.1), C.mid);
    peakLbl.anchor.set(0.5, 0); peakLbl.x = w / 2; peakLbl.y = cy + Math.round(ch * 0.27);
    layer.addChild(peakLbl);

    const peakVal = txt(peakRank, Math.round(ch * 0.14), C.gold, true);
    peakVal.anchor.set(0.5, 0); peakVal.x = w / 2; peakVal.y = cy + Math.round(ch * 0.38);
    layer.addChild(peakVal);

    const newSeasonLbl = txt(t('season.settlement.newSeason', { no: String(newNo) }), Math.round(ch * 0.09), C.accent);
    newSeasonLbl.anchor.set(0.5, 0); newSeasonLbl.x = w / 2; newSeasonLbl.y = cy + Math.round(ch * 0.56);
    layer.addChild(newSeasonLbl);

    // Dismiss button
    const btnH = Math.round(ch * 0.16);
    const btnW = Math.round(cw * 0.5);
    const btnX = (w - btnW) / 2;
    const btnY = cy + Math.round(ch * 0.76);
    const btn = new PIXI.Graphics();
    btn.beginFill(C.dark).drawRoundedRect(btnX, btnY, btnW, btnH, Math.round(btnH * 0.3)).endFill();
    layer.addChild(btn);
    const btnLbl = txt(t('season.settlement.close'), Math.round(btnH * 0.5), 0xffffff, true);
    btnLbl.anchor.set(0.5, 0.5); btnLbl.x = w / 2; btnLbl.y = btnY + btnH / 2;
    layer.addChild(btnLbl);

    this.container.addChild(layer);
    this.settlementLayer = layer;
    this.settlementDismissRect = { x: btnX, y: btnY, w: btnW, h: btnH };
  }

  private clearSettlement(): void {
    this.settlementDismissRect = null;
    if (this.settlementLayer) { this.settlementLayer.destroy({ children: true }); this.settlementLayer = null; }
  }

  /** Draw the toast banner near the top of the lobby (below the header), in its own top-most layer. */
  private drawAchievementToast(text: string): void {
    if (this.toastLayer) { this.toastLayer.destroy({ children: true }); this.toastLayer = null; }
    const { w, h } = this;
    const layer = new PIXI.Container();
    const bw = Math.round(w * 0.82);
    const bh = Math.round(h * 0.072);
    const bx = (w - bw) / 2;
    const by = Math.round(h * 0.165);

    const box = new PIXI.Graphics();
    box.beginFill(C.dark, 0.95);
    box.lineStyle(2, C.gold, 0.95);
    box.drawRoundedRect(bx, by, bw, bh, Math.round(bh * 0.28));
    box.endFill();
    layer.addChild(box);

    const lbl = txt('🏆 ' + text, Math.round(bh * 0.34), 0xffffff, true);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = w / 2; lbl.y = by + bh / 2;
    if (lbl.width > bw * 0.92) lbl.scale.set((bw * 0.92) / lbl.width);
    layer.addChild(lbl);

    this.container.addChild(layer); // top-most, above vsLayer
    this.toastLayer = layer;
    this.toastRect = { x: bx, y: by, w: bw, h: bh };
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.state !== 'idle') return;
    // Season settlement modal (SE-6): dismiss button or anywhere on backdrop dismisses it.
    if (this.settlementLayer) {
      this.clearSettlement();
      return;
    }
    // Achievement-unlock toast tap → jump to the wall (S9-5b). Checked first so it wins over nav slots.
    const tr = this.toastRect;
    if (tr && x >= tr.x && x <= tr.x + tr.w && y >= tr.y && y <= tr.y + tr.h) {
      const open = this.cb.onOpenAchievements;
      this.clearToast();
      if (open) open();
      return;
    }
    const p = this.profileChipRect;
    if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) {
      this.cb.onOpenProfile();
      return;
    }
    if (x >= this.btnRect.x && x <= this.btnRect.x + this.btnRect.w &&
        y >= this.btnRect.y && y <= this.btnRect.y + this.btnRect.h) {
      this.onStartPressed();
      return;
    }
    const camp = this.campaignBtnRect;
    if (x >= camp.x && x <= camp.x + camp.w && y >= camp.y && y <= camp.y + camp.h) {
      this.cb.onOpenCampaign();
      return;
    }
    const daily = this.dailyBtnRect;
    if (this.cb.onOpenDaily && daily.w > 0 &&
        x >= daily.x && x <= daily.x + daily.w && y >= daily.y && y <= daily.y + daily.h) {
      this.cb.onOpenDaily();
      return;
    }
    const ac = this.accountChipRect;
    if (ac && this.accountChipFn &&
        x >= ac.x && x <= ac.x + ac.w && y >= ac.y && y <= ac.y + ac.h) {
      this.accountChipFn();
      return;
    }
    const wld = this.worldNavRect;
    if (x >= wld.x && x <= wld.x + wld.w && y >= wld.y && y <= wld.y + wld.h) {
      if (this.cb.onOpenWorld) this.cb.onOpenWorld();
      return;
    }
    const s = this.socialNavRect;
    if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
      // Social (friends/chat/mail) requires an account; in offline mode route to login.
      if (this.cb.offline && this.cb.onLogin) this.cb.onLogin();
      else if (this.cb.onOpenSocial) this.cb.onOpenSocial();
      else this.cb.onOpenRoom();
      return;
    }
    const sh = this.shopNavRect;
    if (x >= sh.x && x <= sh.x + sh.w && y >= sh.y && y <= sh.y + sh.h) {
      // The shop spends server-authoritative coins → requires an account too.
      if (this.cb.offline && this.cb.onLogin) this.cb.onLogin();
      else this.cb.onOpenShop();
      return;
    }
    // Cards (collection) and stats read local save data → work offline, no gate.
    const cd = this.cardsNavRect;
    if (x >= cd.x && x <= cd.x + cd.w && y >= cd.y && y <= cd.y + cd.h) {
      this.cb.onOpenCards();
      return;
    }
    const st = this.statsNavRect;
    if (x >= st.x && x <= st.x + st.w && y >= st.y && y <= st.y + st.h) {
      this.cb.onOpenStats();
      return;
    }
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  private build(): void {
    const { w, h } = this;

    // Background — procedural notebook paper (sketch.ts), baked once per size.
    this.container.addChild(this.buildBackground());

    // Worn-notebook overlay (art-direction §3.1) — faint grain/creases over the
    // page, below the header/panels so it never hurts UI readability.
    const wear = buildWearOverlay(w, h);
    wear.alpha = 0.55;
    this.container.addChild(wear);

    // Header block
    const tbH = Math.round(h * 0.14);
    const titleBg = new PIXI.Graphics();
    titleBg.beginFill(C.dark);
    titleBg.drawRect(0, 0, w, tbH);
    titleBg.endFill();
    this.container.addChild(titleBg);

    const title = txt(t('lobby.title'), Math.round(h * 0.048), 0xffffff, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2; title.y = tbH * 0.45;
    this.container.addChild(title);

    const subtitle = txt(t('lobby.subtitle'), Math.round(h * 0.022), C.light);
    subtitle.anchor.set(0.5, 0.5); subtitle.x = w / 2; subtitle.y = tbH * 0.78;
    this.container.addChild(subtitle);

    // Top-left profile chip (avatar + name) — opens the personal settings screen.
    const av = Math.round(tbH * 0.46);
    const avX = Math.round(w * 0.03);
    const avY = Math.round(tbH * 0.5 - av / 2);
    const avatar = buildAvatar(av, this.cb.playerName, 21);
    avatar.x = avX; avatar.y = avY;
    this.container.addChild(avatar);

    const nameGap = Math.round(w * 0.02);
    const nameLabel = txt(this.cb.playerName, Math.round(tbH * 0.24), 0xffffff, true);
    nameLabel.anchor.set(0, 0.5);
    nameLabel.x = avX + av + nameGap;
    nameLabel.y = tbH * 0.5;
    // Keep the chip clear of the centred title.
    const nameMax = w * 0.36 - (av + nameGap);
    if (nameLabel.width > nameMax) nameLabel.scale.set(nameMax / nameLabel.width);
    this.container.addChild(nameLabel);

    const pad = Math.round(tbH * 0.12);
    this.profileChipRect = {
      x: avX - pad, y: avY - pad,
      w: av + nameGap + nameLabel.width + 2 * pad, h: av + 2 * pad,
    };

    // Boiling-line title underline (art-direction §5.4) — a hand-drawn marker
    // stroke that subtly wobbles ~8fps. Cycles baked variants; near-zero cost.
    const ulW = Math.min(w * 0.6, title.width * 1.15);
    const ulH = Math.round(h * 0.02);
    this.titleBoil = new BoilingSprite(ulW, ulH, (pen) => {
      pen.stroke(
        [{ x: 2, y: ulH * 0.5 }, { x: ulW - 2, y: ulH * 0.5 }],
        { color: palette.marker, width: Math.max(4, ulH * 0.5), taper: 0.6, double: false },
      );
    }, { tag: 'lobby-title', variants: 3, fps: 8 });
    this.titleBoil.x = w / 2 - ulW / 2;
    this.titleBoil.y = tbH * 0.45 + title.height / 2;
    this.container.addChild(this.titleBoil);

    // Top-right account chip (SA-4): offline → login/register entry; online →
    // server-authoritative ladder badge with a small logout affordance.
    const chipX = w - Math.round(w * 0.04);
    if (this.cb.offline) {
      const login = txt(t('auth.loginEntry'), Math.round(h * 0.024), C.gold, true);
      login.anchor.set(1, 0.5); login.x = chipX; login.y = tbH * 0.5;
      this.container.addChild(login);
      const pad = Math.round(h * 0.02);
      this.accountChipRect = {
        x: login.x - login.width - pad, y: tbH * 0.5 - login.height / 2 - pad,
        w: login.width + 2 * pad, h: login.height + 2 * pad,
      };
      this.accountChipFn = this.cb.onLogin ?? null;
    } else if (this.cb.pvp) {
      const pvp = this.cb.pvp;
      const rankName = t(('rank.' + pvp.rank) as TranslationKey);
      const badge = pvp.rank === 'unranked' ? rankName : `${rankName} · ${pvp.elo}`;
      const badgeLabel = txt(badge, Math.round(h * 0.022), C.gold, true);
      badgeLabel.anchor.set(1, 0.5); badgeLabel.x = chipX; badgeLabel.y = tbH * 0.40;
      this.container.addChild(badgeLabel);
      if (this.cb.onLogout) {
        const out = txt(t('auth.logout'), Math.round(h * 0.018), C.light);
        out.anchor.set(1, 0.5); out.x = chipX; out.y = tbH * 0.68;
        this.container.addChild(out);
        const pad = Math.round(h * 0.012);
        this.accountChipRect = {
          x: out.x - out.width - pad, y: out.y - out.height / 2 - pad,
          w: out.width + 2 * pad, h: out.height + 2 * pad,
        };
        this.accountChipFn = this.cb.onLogout;
      }
    }

    // Feature blocks
    const blockY   = tbH + Math.round(h * 0.06);
    const blockH   = Math.round(h * 0.10);
    const blockW   = Math.round(w * 0.82);
    const blockX   = (w - blockW) / 2;
    const blockGap = Math.round(h * 0.015);

    [
      t('lobby.feature.1'),
      t('lobby.feature.2'),
      t('lobby.feature.3'),
    ].forEach((label, i) => {
      const box = this.sketchPanel(blockW, blockH, { fill: C.paper, border: C.dark, width: 2, seed: 11 + i });
      box.x = blockX;
      box.y = blockY + i * (blockH + blockGap);
      this.container.addChild(box);

      // Blue ink accent stroke down the left edge (replaces the flat bar).
      new SketchPen(box, 31 + i).line(4, 5, 4, blockH - 5, { color: C.accent, width: 4, jitter: 0.8, taper: 0.85 });

      const lbl = txt(label, Math.round(blockH * 0.28), C.dark);
      lbl.anchor.set(0, 0.5); lbl.x = 16; lbl.y = blockH / 2;
      box.addChild(lbl);
    });

    // Start button
    const btnW = Math.round(w * 0.72);
    const btnH = Math.round(h * 0.082);
    const btnX = (w - btnW) / 2;
    const btnY = Math.round(h * 0.63);
    this.btnRect = { x: btnX, y: btnY, w: btnW, h: btnH };

    this.btnBg = new PIXI.Graphics();
    this.drawBtn(this.btnBg, btnW, btnH, true);
    this.btnBg.x = btnX; this.btnBg.y = btnY;
    this.container.addChild(this.btnBg);

    this.btnLabel = txt(t('lobby.startMatch'), Math.round(btnH * 0.42), 0xffffff, true);
    this.btnLabel.anchor.set(0.5, 0.5);
    this.btnLabel.x = btnX + btnW / 2;
    this.btnLabel.y = btnY + btnH / 2;
    this.container.addChild(this.btnLabel);

    // Campaign (PvE) — a single notebook front door below the match button.
    // (Replaced the demo-era 1-4 numbered picker; unlock chain / stars / chapter
    // narrative all live behind this one entry now — CAMPAIGN_DESIGN §12.)
    const campH = Math.round(h * 0.07);
    const campY = btnY + btnH + Math.round(h * 0.026);
    this.campaignBtnRect = { x: btnX, y: campY, w: btnW, h: campH };

    const cbg = this.sketchPanel(btnW, campH, { fill: C.paper, border: C.gold, width: 2.6, seed: 51 });
    cbg.x = btnX; cbg.y = campY;
    this.container.addChild(cbg);
    // Gold ink accent stroke down the left edge — echoes the feature blocks.
    new SketchPen(cbg, 0x55).line(4, 5, 4, campH - 5, { color: C.gold, width: 5, jitter: 0.8, taper: 0.85 });

    // Daily check-in shortcut below campaign button (B5).
    if (this.cb.onOpenDaily) {
      const dailyH = Math.round(campH * 0.75);
      const dailyY = campY + campH + Math.round(h * 0.012);
      const dailyW = Math.round(btnW * 0.45);
      this.dailyBtnRect = { x: btnX, y: dailyY, w: dailyW, h: dailyH };
      const dbg = this.sketchPanel(dailyW, dailyH, { fill: this.retentionBadge ? 0xfff3cc : C.paper, border: C.gold, width: 1.8, seed: 71 });
      dbg.x = btnX; dbg.y = dailyY;
      this.container.addChild(dbg);
      const dlabel = txt(t('daily.title'), Math.round(dailyH * 0.44), C.dark);
      dlabel.anchor.set(0.5, 0.5);
      dlabel.x = btnX + dailyW / 2; dlabel.y = dailyY + dailyH / 2;
      this.container.addChild(dlabel);
      if (this.retentionBadge) {
        const dot = new PIXI.Graphics();
        dot.beginFill(0xff3333);
        dot.lineStyle(2, 0xffffff, 0.9);
        dot.drawCircle(btnX + dailyW - 6, dailyY + 6, 6);
        dot.endFill();
        this.container.addChild(dot);
      }
    }

    const campLabel = txt(t('lobby.campaign'), Math.round(campH * 0.4), C.dark, true);
    campLabel.anchor.set(0.5, 0.5);
    campLabel.x = btnX + btnW / 2;
    campLabel.y = campY + campH / 2;
    this.container.addChild(campLabel);

    // Bottom nav bar
    const navH  = Math.round(h * 0.08);
    const navBg = new PIXI.Graphics();
    navBg.beginFill(C.dark, 0.9);
    navBg.drawRect(0, h - navH, w, navH);
    navBg.endFill();
    this.container.addChild(navBg);

    [
      t('lobby.nav.cards'), t('lobby.nav.stats'), t('lobby.nav.home'),
      t('lobby.nav.shop'), t('lobby.nav.social'),
    ].forEach((name, i) => {
      const slotW = w / 5;
      const slotX = i * slotW + slotW / 2;
      const slotY = h - navH / 2;
      // All five slots are wired now: cards (0), stats (1), home (2), shop (3),
      // social (4). Home is the current page (no-op).
      const active = true;
      const dotColor = [C.red, C.accent, C.accent, C.green, C.gold][i] ?? C.mid;

      const dot = new PIXI.Graphics();
      dot.beginFill(dotColor, active ? 0.8 : 0.3);
      dot.drawCircle(0, 0, Math.round(navH * 0.17));
      dot.endFill();
      dot.x = slotX; dot.y = slotY - Math.round(navH * 0.18);
      navBg.addChild(dot);

      const navLabel = txt(name, Math.round(navH * 0.22), active ? C.light : C.mid);
      navLabel.anchor.set(0.5, 0);
      navLabel.x = slotX; navLabel.y = slotY + Math.round(navH * 0.04);
      navBg.addChild(navLabel);

      const navRect = { x: i * slotW, y: h - navH, w: slotW, h: navH };
      if (i === 0)      this.cardsNavRect  = navRect;
      else if (i === 1) this.statsNavRect  = navRect;
      else if (i === 2) this.worldNavRect  = navRect;
      else if (i === 3) this.shopNavRect   = navRect;
      else if (i === 4) this.socialNavRect = navRect;
    });

    // Aggregate social unread badge (count bubble) drawn over the social slot.
    // Lives in its own layer so applySocialBadge() can refresh it cheaply.
    this.socialBadgeLayer = new PIXI.Container();
    navBg.addChild(this.socialBadgeLayer);
    this.drawSocialBadge();

    // Achievement claimable dot over the stats slot (its own layer for cheap refresh).
    this.achievementBadgeLayer = new PIXI.Container();
    navBg.addChild(this.achievementBadgeLayer);
    this.drawAchievementBadge();

    // World-offline indicator (redrawn when applyWorldAvailable() is called).
    this.worldOfflineBadgeLayer = new PIXI.Container();
    navBg.addChild(this.worldOfflineBadgeLayer);

    // VS overlay
    this.vsLayer = this.buildVsLayer(w, h);
    this.vsLayer.visible = false;
    this.container.addChild(this.vsLayer);
  }

  /** Draw (or clear) the social unread bubble at the top-right of the social nav dot. */
  private drawSocialBadge(): void {
    const layer = this.socialBadgeLayer;
    if (!layer) return;
    layer.removeChildren();
    if (this.socialBadge <= 0) return;

    const s = this.socialNavRect;
    const navH = s.h;
    const dotR  = Math.round(navH * 0.17);
    const cx = s.x + s.w / 2 + dotR;
    const cy = s.y + navH / 2 - Math.round(navH * 0.18) - dotR;

    const label = this.socialBadge > 99 ? '99+' : String(this.socialBadge);
    const txtNode = txt(label, Math.round(navH * 0.24), 0xffffff, true);
    txtNode.anchor.set(0.5, 0.5);
    const r = Math.max(Math.round(navH * 0.16), txtNode.width / 2 + Math.round(navH * 0.08));

    const g = new PIXI.Graphics();
    g.beginFill(C.red);
    g.lineStyle(2, C.light, 0.9);
    g.drawCircle(cx, cy, r);
    g.endFill();
    layer.addChild(g);
    txtNode.x = cx; txtNode.y = cy;
    layer.addChild(txtNode);
  }

  /** Draw (or clear) a small red dot at the top-right of the stats nav dot when a reward is claimable. */
  private drawAchievementBadge(): void {
    const layer = this.achievementBadgeLayer;
    if (!layer) return;
    layer.removeChildren();
    if (!this.achievementBadge) return;

    const s = this.statsNavRect;
    const navH = s.h;
    const dotR = Math.round(navH * 0.17);
    const cx = s.x + s.w / 2 + dotR;
    const cy = s.y + navH / 2 - Math.round(navH * 0.18) - dotR;
    const r = Math.round(navH * 0.12);

    const g = new PIXI.Graphics();
    g.beginFill(C.red);
    g.lineStyle(2, C.light, 0.9);
    g.drawCircle(cx, cy, r);
    g.endFill();
    layer.addChild(g);
  }

  /**
   * Called after a worldsvc reachability check (ping /health) resolves.
   * Shows a small "×" badge on the 大世界 nav slot when the service is down,
   * so developers see immediately that worldsvc isn't running — without having to
   * click the button and wait for the 3-second timeout.
   */
  applyWorldAvailable(ok: boolean): void {
    if (this.destroyed) return;
    this.worldOnline = ok;
    this.drawWorldOfflineBadge();
  }

  private drawWorldOfflineBadge(): void {
    const layer = this.worldOfflineBadgeLayer;
    if (!layer) return;
    layer.removeChildren();
    if (this.worldOnline !== false) return; // null (not yet checked) or true → nothing to show

    const s = this.worldNavRect;
    const navH = s.h;
    // "×" rendered at the top-left corner of the world nav dot so it doesn't clash with the label.
    const dotR = Math.round(navH * 0.17);
    const cx = s.x + s.w / 2 - dotR - Math.round(navH * 0.06);
    const cy = s.y + navH / 2 - Math.round(navH * 0.18) - dotR;

    const lbl = txt('×', Math.round(navH * 0.30), C.red, true);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = cx; lbl.y = cy;
    lbl.alpha = 0.85;
    layer.addChild(lbl);
  }

  /**
   * Procedural notebook background drawn with the shared SketchPen: aged paper,
   * hand-drawn faint-blue ruled lines, and a red "teacher's margin" line down
   * the left (diegetic correcting pen, double-stroked for emphasis). Baked to a
   * texture cached per (w,h) so it costs nothing per frame; falls back to live
   * Graphics if no renderer is wired.
   */
  private buildBackground(): PIXI.DisplayObject {
    const { w, h } = this;
    const gfx = new PIXI.Graphics();
    gfx.beginFill(C.bg);
    gfx.drawRect(0, 0, w, h);
    gfx.endFill();

    const pen = new SketchPen(gfx, 0x5bd1c7);
    const lineGap = Math.round(h / 28);
    for (let y = lineGap; y < h; y += lineGap) {
      pen.line(0, y, w, y, { color: palette.ruleLine, width: 1.1, jitter: 0.7, taper: 0.9, double: false });
    }
    const mx = Math.round(w * 0.09);
    pen.line(mx, 0, mx, h, { color: palette.inkRed, width: 2.2, jitter: 1.0, taper: 0.95 });

    const tex = bake(`lobbybg:${Math.round(w)}x${Math.round(h)}`, gfx, w, h);
    if (tex) {
      const s = new PIXI.Sprite(tex);
      gfx.destroy();
      return s;
    }
    return gfx;
  }

  /**
   * Shared hand-drawn panel: flat fill + a scribbled SketchPen border. A fixed
   * seed keeps each panel's scrawl stable across redraws. Used for the feature
   * blocks, campaign buttons, start button, and VS player cards so the whole
   * lobby reads as one notebook doodle.
   */
  private sketchPanel(
    w: number, h: number,
    opts: { fill: number; border: number; width?: number; seed?: number },
  ): PIXI.Graphics {
    const g = new PIXI.Graphics();
    g.beginFill(opts.fill);
    g.drawRect(0, 0, w, h);
    g.endFill();
    new SketchPen(g, opts.seed ?? 7).rect(2, 2, w - 4, h - 4, {
      color: opts.border, width: opts.width ?? 2, jitter: 1.0,
    });
    return g;
  }

  private drawBtn(gfx: PIXI.Graphics, w: number, h: number, enabled: boolean): void {
    gfx.clear();
    gfx.beginFill(enabled ? C.dark : C.btnOff);
    gfx.drawRect(0, 0, w, h);
    gfx.endFill();
    new SketchPen(gfx, 5).rect(2, 2, w - 4, h - 4, {
      color: enabled ? C.accent : C.light, width: 2.4, jitter: 1.0,
    });
  }

  private buildVsLayer(w: number, h: number): PIXI.Container {
    const c = new PIXI.Container();

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.82);
    dim.drawRect(0, 0, w, h);
    dim.endFill();
    c.addChild(dim);

    const cardW = Math.round(w * 0.62);
    const cardH = Math.round(h * 0.12);
    const cardX = (w - cardW) / 2;

    const youCard = this.buildPlayerCard(cardW, cardH, t('lobby.you'), C.accent);
    youCard.x = cardX; youCard.y = Math.round(h * 0.28);
    c.addChild(youCard);

    const vs = txt(t('lobby.vs'), Math.round(h * 0.09), C.gold, true);
    vs.anchor.set(0.5, 0.5); vs.x = w / 2; vs.y = h * 0.5;
    c.addChild(vs);

    const oppCard = this.buildPlayerCard(cardW, cardH, '', C.red);
    oppCard.x = cardX; oppCard.y = Math.round(h * 0.58);
    c.addChild(oppCard);
    this.oppLabel = oppCard.getChildByName('nameLabel') as PIXI.Text;

    const hint = txt(t('lobby.loading'), Math.round(h * 0.022), C.mid);
    hint.anchor.set(0.5, 0); hint.x = w / 2; hint.y = h * 0.8;
    c.addChild(hint);

    return c;
  }

  private buildPlayerCard(w: number, h: number, name: string, accentColor: number): PIXI.Container {
    // Seed by side colour so the you/opp cards scrawl differently.
    const bg = this.sketchPanel(w, h, { fill: C.paper, border: accentColor, width: 2.4, seed: accentColor });
    // Ink accent stroke down the left edge.
    new SketchPen(bg, accentColor ^ 0x55).line(4, 5, 4, h - 5, { color: accentColor, width: 5, jitter: 0.8, taper: 0.85 });
    const nameLabel = txt(name, Math.round(h * 0.45), C.dark, true);
    nameLabel.name = 'nameLabel'; nameLabel.anchor.set(0, 0.5);
    nameLabel.x = Math.round(w * 0.08); nameLabel.y = h / 2;
    bg.addChild(nameLabel);
    return bg;
  }

  private onStartPressed(): void {
    // Online + logged in → real PvP ranked matchmaking (RoomScene searching flow).
    // Offline / no server → the local AI quick-match below.
    if (this.cb.online && this.cb.onStartRanked) {
      this.cb.onStartRanked();
      return;
    }
    this.state = 'matching'; this.matchTimer = 0; this.dotsTimer = 0; this.dotCount = 0;
    // Use the stored rect, not gfx.width — the sketch stroke overshoots the box,
    // so re-reading bounds would grow the button on every redraw.
    this.drawBtn(this.btnBg, this.btnRect.w, this.btnRect.h, false);
    this.btnLabel.text = t('lobby.matching') + '...';
  }

  private matchFound(): void {
    this.state = 'vs'; this.vsTimer = 0;
    this.opponentName  = randomAiName();
    this.oppLabel.text = this.opponentName;
    this.vsLayer.visible = true;
  }
}
