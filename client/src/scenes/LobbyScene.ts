import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { SketchPen } from '../render/sketch';
import { palette } from '../render/theme';
import { bake } from '../render/bake';
import { buildIcon, IconKind } from '../render/icons';
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

/** Compact coin formatting for the header chip (e.g. 1234 → "1,234", 23456 → "23.5k"). */
function fmtCoins(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v >= 10000) return (v / 1000).toFixed(v >= 100000 ? 0 : 1) + 'k';
  return v.toLocaleString('en-US');
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
  /** Open the limited-time events screen (B6, ADR-014). Entry only appears when an event window is live. */
  onOpenEvents?(): void;
  /** Open the personal profile / settings screen (top-left profile chip). */
  onOpenProfile(): void;
  /** Player display name shown in the top-left profile chip. */
  playerName: string;
  /** Server-authoritative ladder standing (SaveData.pvp); shown as a header badge. */
  pvp?: { rank: string; elo: number };
  /** Server-authoritative soft-currency balance (SaveData.wallet.coins); shown in the header (online only). */
  coins?: number;
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
  /** Hit rect for the 大世界 (SLG) pillar card — promoted out of the bottom nav into the main layout. */
  private worldPillarRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
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
  /** B6: whether a live event window exists → show the 活动 entry. */
  private eventsAvailable = false;
  /** Hit rect for the events button (right of the daily button). */
  private eventsBtnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
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
    this.rebuild();
  }

  /** B6: mark whether a live event window exists → show / hide the 活动 entry button. */
  applyEventsAvailable(available: boolean): void {
    if (this.destroyed) return;
    if (this.eventsAvailable === available) return;
    this.eventsAvailable = available;
    this.rebuild();
  }

  /** Full teardown + rebuild — needed when a layout element (daily/events button) appears or changes. */
  private rebuild(): void {
    // Full rebuild needed since the daily / events buttons are part of the main layout.
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

    // Hand-drawn trophy icon + label, centred as a group (replaces the 🏆 glyph).
    const ti = Math.round(bh * 0.58);
    const gap = Math.round(bh * 0.2);
    const lbl = txt(text, Math.round(bh * 0.34), 0xffffff, true);
    lbl.anchor.set(0, 0.5);
    const maxLblW = bw * 0.92 - ti - gap;
    if (lbl.width > maxLblW) lbl.scale.set(maxLblW / lbl.width);
    const total = ti + gap + lbl.width;
    const left = (w - total) / 2;

    const trophy = buildIcon('trophy', ti, C.gold);
    trophy.x = Math.round(left); trophy.y = Math.round(by + bh / 2 - ti / 2);
    layer.addChild(trophy);
    lbl.x = left + ti + gap; lbl.y = by + bh / 2;
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
    // 大世界 (SLG) pillar — promoted out of the bottom nav into the main layout.
    const wp = this.worldPillarRect;
    if (wp.w > 0 && x >= wp.x && x <= wp.x + wp.w && y >= wp.y && y <= wp.y + wp.h) {
      if (this.cb.onOpenWorld) this.cb.onOpenWorld();
      return;
    }
    const daily = this.dailyBtnRect;
    if (this.cb.onOpenDaily && daily.w > 0 &&
        x >= daily.x && x <= daily.x + daily.w && y >= daily.y && y <= daily.y + daily.h) {
      this.cb.onOpenDaily();
      return;
    }
    const ev = this.eventsBtnRect;
    if (this.cb.onOpenEvents && ev.w > 0 &&
        x >= ev.x && x <= ev.x + ev.w && y >= ev.y && y <= ev.y + ev.h) {
      this.cb.onOpenEvents();
      return;
    }
    const ac = this.accountChipRect;
    if (ac && this.accountChipFn &&
        x >= ac.x && x <= ac.x + ac.w && y >= ac.y && y <= ac.y + ac.h) {
      this.accountChipFn();
      return;
    }
    // Bottom-nav center slot is now "home" (the lobby itself) — current page, no-op.
    // Shop + social slots are only drawn when online (offline omits them entirely),
    // so a zero-width rect here means the slot is absent — guard with w > 0.
    const s = this.socialNavRect;
    if (s.w > 0 && x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
      if (this.cb.onOpenSocial) this.cb.onOpenSocial();
      else this.cb.onOpenRoom();
      return;
    }
    const sh = this.shopNavRect;
    if (sh.w > 0 && x >= sh.x && x <= sh.x + sh.w && y >= sh.y && y <= sh.y + sh.h) {
      this.cb.onOpenShop();
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
      // Three stacked lines in the header's right column: coins · rank · logout.
      const hasLogout = !!this.cb.onLogout;
      const coinsY = tbH * 0.30;
      const rankY  = hasLogout ? tbH * 0.55 : tbH * 0.45;
      const outY   = tbH * 0.80;

      // Soft-currency balance (server-authoritative mirror) — only meaningful online.
      if (typeof this.cb.coins === 'number') {
        const coinLbl = txt(fmtCoins(this.cb.coins), Math.round(h * 0.022), C.gold, true);
        coinLbl.anchor.set(1, 0.5); coinLbl.x = chipX; coinLbl.y = coinsY;
        this.container.addChild(coinLbl);
        // Hand-drawn coin icon to the left of the number (replaces the 🪙 glyph).
        const ci = Math.round(h * 0.032);
        const coinIcon = buildIcon('coin', ci, C.gold);
        coinIcon.x = Math.round(chipX - coinLbl.width - Math.round(h * 0.01) - ci);
        coinIcon.y = Math.round(coinsY - ci / 2);
        this.container.addChild(coinIcon);
      }

      const rankName = t(('rank.' + pvp.rank) as TranslationKey);
      const badge = pvp.rank === 'unranked' ? rankName : `${rankName} · ${pvp.elo}`;
      const badgeLabel = txt(badge, Math.round(h * 0.022), C.light, true);
      badgeLabel.anchor.set(1, 0.5); badgeLabel.x = chipX; badgeLabel.y = rankY;
      this.container.addChild(badgeLabel);
      if (this.cb.onLogout) {
        const out = txt(t('auth.logout'), Math.round(h * 0.016), C.mid);
        out.anchor.set(1, 0.5); out.x = chipX; out.y = outY;
        this.container.addChild(out);
        const pad = Math.round(h * 0.012);
        this.accountChipRect = {
          x: out.x - out.width - pad, y: out.y - out.height / 2 - pad,
          w: out.width + 2 * pad, h: out.height + 2 * pad,
        };
        this.accountChipFn = this.cb.onLogout;
      }
    }

    // ── Main content stack ─────────────────────────────────────────────────
    // A vertically-centred column between the header and the bottom nav:
    //   1. Hero "开始匹配" button (primary action)
    //   2. Two equal pillars: 战役 (PvE) | 大世界 (SLG)
    //   3. Engagement row: 每日 | 限时活动 (online only)
    // The old new-player feature blurbs were removed — everyone sees the same
    // action-first home (UI_DESIGN: lobby redesign).
    const navH = Math.round(h * 0.08);
    const contentW = Math.round(w * 0.82);
    const contentX = Math.round((w - contentW) / 2);

    const heroH   = Math.round(h * 0.135);
    const pillarH = Math.round(h * 0.165);
    const chipH   = Math.round(h * 0.082);
    const gapA    = Math.round(h * 0.04);  // hero → pillars
    const gapB    = Math.round(h * 0.03);  // pillars → chips
    const hasEngagement = !!this.cb.onOpenDaily;

    const stackH = heroH + gapA + pillarH + (hasEngagement ? gapB + chipH : 0);
    const usableTop = tbH;
    const usableH   = (h - navH) - tbH;
    const startY = usableTop + Math.max(Math.round(h * 0.04), Math.round((usableH - stackH) / 2));

    const heroY    = startY;
    const pillarsY = heroY + heroH + gapA;
    const chipsY   = pillarsY + pillarH + gapB;

    // 1. Hero — start match. Offline → local 人机对战; online → PvP ranked.
    this.btnRect = { x: contentX, y: heroY, w: contentW, h: heroH };
    this.btnBg = new PIXI.Graphics();
    this.drawBtn(this.btnBg, contentW, heroH, true);
    this.btnBg.x = contentX; this.btnBg.y = heroY;
    this.container.addChild(this.btnBg);

    this.btnLabel = txt(this.cb.offline ? t('lobby.startVsAI') : t('lobby.startMatch'), Math.round(heroH * 0.30), 0xffffff, true);
    this.btnLabel.anchor.set(0.5, 0.5);
    this.btnLabel.x = contentX + contentW / 2;
    this.btnLabel.y = heroY + heroH * 0.38;
    this.container.addChild(this.btnLabel);

    const heroSubKey: TranslationKey = this.cb.offline
      ? 'lobby.match.subSolo'
      : (this.cb.online ? 'lobby.match.subRanked' : 'lobby.match.subAI');
    const heroSub = txt(t(heroSubKey), Math.round(heroH * 0.15), C.light);
    heroSub.anchor.set(0.5, 0.5);
    heroSub.x = contentX + contentW / 2;
    heroSub.y = heroY + heroH * 0.70;
    this.container.addChild(heroSub);

    // 2. Pillars: 战役 (gold, PvE) | 大世界 (accent, SLG). 大世界 needs an account,
    // so it's hidden in offline mode — 战役 then takes the full content width.
    const showWorld = !this.cb.offline && !!this.cb.onOpenWorld;
    const pillarGap = Math.round(w * 0.025);
    const pw = showWorld ? Math.round((contentW - pillarGap) / 2) : contentW;

    this.campaignBtnRect = { x: contentX, y: pillarsY, w: pw, h: pillarH };
    this.drawPillar(contentX, pillarsY, pw, pillarH, C.gold, 'book',
      t('lobby.campaign'), t('lobby.campaign.sub'), 51);

    if (showWorld) {
      const worldX = contentX + pw + pillarGap;
      this.worldPillarRect = { x: worldX, y: pillarsY, w: pw, h: pillarH };
      this.drawPillar(worldX, pillarsY, pw, pillarH, C.accent, 'globe',
        t('lobby.world'), t('lobby.world.sub'), 53);
    } else {
      this.worldPillarRect = { x: 0, y: 0, w: 0, h: 0 };
    }

    // 3. Engagement row — 每日 | 限时活动 (only when wired, i.e. online).
    if (hasEngagement) {
      const chipGap = Math.round(w * 0.025);
      const cw = Math.round((contentW - chipGap) / 2);

      // 每日 check-in (B5) — warm fill + red dot when a reward is claimable.
      this.dailyBtnRect = { x: contentX, y: chipsY, w: cw, h: chipH };
      const dbg = this.sketchPanel(cw, chipH, { fill: this.retentionBadge ? 0xfff3cc : C.paper, border: C.gold, width: 1.8, seed: 71 });
      dbg.x = contentX; dbg.y = chipsY;
      this.container.addChild(dbg);
      const dlabel = txt(t('daily.title'), Math.round(chipH * 0.4), C.dark, true);
      dlabel.anchor.set(0.5, 0.5);
      dlabel.x = contentX + cw / 2; dlabel.y = chipsY + chipH / 2;
      this.container.addChild(dlabel);
      if (this.retentionBadge) {
        const dot = new PIXI.Graphics();
        dot.beginFill(0xff3333);
        dot.lineStyle(2, 0xffffff, 0.9);
        dot.drawCircle(contentX + cw - 8, chipsY + 8, 7);
        dot.endFill();
        this.container.addChild(dot);
      }

      // 限时活动 (B6) — always shown for balance; greyed + inert when no live window.
      const evX = contentX + cw + chipGap;
      const live = !!this.cb.onOpenEvents && this.eventsAvailable;
      this.eventsBtnRect = live ? { x: evX, y: chipsY, w: cw, h: chipH } : { x: 0, y: 0, w: 0, h: 0 };
      const ebg = this.sketchPanel(cw, chipH, {
        fill: live ? 0xfff3cc : C.paper, border: live ? C.red : C.light, width: 1.8, seed: 73,
      });
      ebg.x = evX; ebg.y = chipsY;
      this.container.addChild(ebg);
      const elabel = txt(t('event.title'), Math.round(chipH * 0.38), live ? C.dark : C.mid, true);
      elabel.anchor.set(0.5, 0.5);
      elabel.x = evX + cw / 2; elabel.y = chipsY + chipH / 2;
      this.container.addChild(elabel);
    }

    // Bottom nav. The center slot is the lobby itself (was 大世界, promoted to a
    // pillar above), so it renders as the active tab and is a no-op on tap.
    // Shop + social need an account → omitted entirely in offline mode; the
    // remaining slots (cards · home · stats read local save) redistribute evenly.
    const navBg = new PIXI.Graphics();
    navBg.beginFill(C.dark, 0.9);
    navBg.drawRect(0, h - navH, w, navH);
    navBg.endFill();
    this.container.addChild(navBg);

    // Reset gated rects so a stale rect can't be hit when its slot isn't drawn.
    this.shopNavRect   = { x: 0, y: 0, w: 0, h: 0 };
    this.socialNavRect = { x: 0, y: 0, w: 0, h: 0 };

    interface NavSlot { name: string; color: number; active?: boolean; assign?: (r: Rect) => void; }
    const slots: NavSlot[] = [
      { name: t('lobby.nav.cards'), color: C.red,    assign: r => { this.cardsNavRect = r; } },
      { name: t('lobby.nav.stats'), color: C.accent, assign: r => { this.statsNavRect = r; } },
      { name: t('lobby.nav.home'),  color: C.accent, active: true },
    ];
    if (!this.cb.offline) {
      slots.push({ name: t('lobby.nav.shop'),   color: C.green, assign: r => { this.shopNavRect = r; } });
      slots.push({ name: t('lobby.nav.social'), color: C.gold,  assign: r => { this.socialNavRect = r; } });
    }

    const n = slots.length;
    slots.forEach((slot, i) => {
      const slotW = w / n;
      const slotX = i * slotW + slotW / 2;
      const slotY = h - navH / 2;
      const active = !!slot.active;
      const dotColor = slot.color;

      // Active tab: a short accent bar across the top edge of the slot.
      if (active) {
        const barW = Math.round(slotW * 0.5);
        const bar = new PIXI.Graphics();
        bar.beginFill(dotColor, 0.95);
        bar.drawRect(slotX - barW / 2, h - navH, barW, Math.max(2, Math.round(navH * 0.05)));
        bar.endFill();
        navBg.addChild(bar);
      }

      const dot = new PIXI.Graphics();
      dot.beginFill(dotColor, active ? 1.0 : 0.7);
      dot.drawCircle(0, 0, Math.round(navH * (active ? 0.21 : 0.15)));
      dot.endFill();
      dot.x = slotX; dot.y = slotY - Math.round(navH * 0.18);
      navBg.addChild(dot);

      const navLabel = txt(slot.name, Math.round(navH * (active ? 0.24 : 0.21)), active ? 0xffffff : C.light, active);
      navLabel.anchor.set(0.5, 0);
      navLabel.alpha = active ? 1.0 : 0.78;
      navLabel.x = slotX; navLabel.y = slotY + Math.round(navH * 0.04);
      navBg.addChild(navLabel);

      slot.assign?.({ x: i * slotW, y: h - navH, w: slotW, h: navH });
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

    // World-offline indicator over the 大世界 pillar (redrawn when applyWorldAvailable() is called).
    this.worldOfflineBadgeLayer = new PIXI.Container();
    this.container.addChild(this.worldOfflineBadgeLayer);
    this.drawWorldOfflineBadge();

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
   * Shows a small "离线" badge on the 大世界 pillar when the service is down,
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
    if (this.worldOnline !== false) return;       // null (not yet checked) or true → nothing to show
    const p = this.worldPillarRect;
    if (p.w <= 0) return;                          // world pillar not present (offline mode)

    // Small "离线" tag pinned to the top-right corner of the 大世界 pillar.
    const tagH = Math.round(p.h * 0.22);
    const lbl = txt('离线', Math.round(tagH * 0.7), 0xffffff, true);
    const tagW = Math.round(lbl.width + tagH * 0.6);
    const tagX = p.x + p.w - tagW - Math.round(p.h * 0.08);
    const tagY = p.y + Math.round(p.h * 0.08);

    const bg = new PIXI.Graphics();
    bg.beginFill(C.red, 0.92).drawRoundedRect(tagX, tagY, tagW, tagH, Math.round(tagH * 0.3)).endFill();
    layer.addChild(bg);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = tagX + tagW / 2; lbl.y = tagY + tagH / 2;
    layer.addChild(lbl);
  }

  /**
   * A pillar card for the main lobby grid (战役 / 大世界): hand-drawn panel +
   * coloured left-edge ink stroke + a SketchPen line-art icon, title and
   * subtitle. Shares the notebook-doodle language with the feature panels and
   * VS cards (icons replace the old emoji placeholders).
   */
  private drawPillar(
    x: number, y: number, w: number, h: number,
    accent: number, icon: IconKind, title: string, sub: string, seed: number,
  ): void {
    const bg = this.sketchPanel(w, h, { fill: C.paper, border: accent, width: 2.6, seed });
    bg.x = x; bg.y = y;
    this.container.addChild(bg);
    // Coloured ink accent stroke down the left edge.
    new SketchPen(bg, seed ^ 0x55).line(4, 6, 4, h - 6, { color: accent, width: 5, jitter: 0.8, taper: 0.85 });

    // Hand-drawn glyph, centred on the upper third like the old emoji did, in
    // the pillar's accent ink so each pillar keeps its colour identity.
    const iconSize = Math.round(h * 0.36);
    const glyph = buildIcon(icon, iconSize, accent);
    glyph.x = Math.round(x + w / 2 - iconSize / 2);
    glyph.y = Math.round(y + h * 0.32 - iconSize / 2);
    this.container.addChild(glyph);

    const titleLbl = txt(title, Math.round(h * 0.22), C.dark, true);
    titleLbl.anchor.set(0.5, 0.5);
    titleLbl.x = x + w / 2; titleLbl.y = y + h * 0.64;
    this.container.addChild(titleLbl);

    const subLbl = txt(sub, Math.round(h * 0.12), C.mid);
    subLbl.anchor.set(0.5, 0.5);
    subLbl.x = x + w / 2; subLbl.y = y + h * 0.84;
    this.container.addChild(subLbl);
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
