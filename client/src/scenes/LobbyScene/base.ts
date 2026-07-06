// Shared foundation for the LobbyScene mixin chain (see ../LobbyScene.ts assembly).
// LobbySceneBase holds every instance field (all `protected`, so the domain mixins keep referencing them
// verbatim: this.btnRect, this.socialBadge, …) + the Scene interface (constructor/update/destroy) + the
// shared render primitives (txt/fmtCoins/sketchPanel/drawBtn/buildBackground/randomAiName) used across the
// mixins. Each domain (layout/build, badges, overlays) lives in its own sibling file as an `XMixin(Base)`
// and is chained together into the final LobbyScene.
import * as PIXI from 'pixi.js-legacy';
import { ILayout, Rect } from '../../layout/ILayout';
import { InputManager } from '../../inputSystem/InputManager';
import { t } from '../../i18n';
import { SketchPen } from '../../render/sketch';
import { palette } from '../../render/theme';
import { bake } from '../../render/bake';
import { IconKind } from '../../render/icons';
import { BoilingSprite } from '../../render/boil';
import { StickmanRuntime } from '../../render/stickman/StickmanRuntime';
import { loadCoinIconAtlas } from '../../render/coinIconAtlas';

export { fmtCoins } from './format';

// ── AI name pool ───────────────────────────────────────────────────────────────

const AI_NAMES = [
  'Scribble', 'Doodler', 'InkMaster', 'PencilWarrior', 'Eraserhead',
  'LoopyLines', 'SketchBot', 'NoteSlayer', 'RuledPage', 'BlotterKing',
  'QuillStrike', 'MarginNotes', 'CrayonCrusher', 'GraphiteFist', 'InkWell',
];

export function randomAiName(): string {
  return AI_NAMES[Math.floor(Math.random() * AI_NAMES.length)]!;
}

export const C = {
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

export function txt(label: string, size: number, color: number, bold = false): PIXI.Text {
  return new PIXI.Text(label, {
    fontSize: size, fill: color, fontFamily: 'monospace',
    fontWeight: bold ? 'bold' : 'normal',
  });
}

/**
 * Shared hand-drawn panel: flat fill + a scribbled SketchPen border. A fixed
 * seed keeps each panel's scrawl stable across redraws. Used for the feature
 * blocks, campaign buttons, start button, and VS player cards so the whole
 * lobby reads as one notebook doodle.
 */
export function sketchPanel(
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

export function drawBtn(gfx: PIXI.Graphics, w: number, h: number, enabled: boolean): void {
  gfx.clear();
  gfx.beginFill(enabled ? C.dark : C.btnOff);
  gfx.drawRect(0, 0, w, h);
  gfx.endFill();
  new SketchPen(gfx, 5).rect(2, 2, w - 4, h - 4, {
    color: enabled ? C.accent : C.light, width: 2.4, jitter: 1.0,
  });
}

/**
 * Procedural notebook background drawn with the shared SketchPen: aged paper,
 * hand-drawn faint-blue ruled lines, and a red "teacher's margin" line down
 * the left (diegetic correcting pen, double-stroked for emphasis). Baked to a
 * texture cached per (w,h) so it costs nothing per frame; falls back to live
 * Graphics if no renderer is wired.
 */
export function buildBackground(w: number, h: number): PIXI.DisplayObject {
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
  /**
   * Open the SLG auction house directly from the lobby (AUCTION_DESIGN dual-entry:
   * lobby + world map). The market is season-global, so no base is required; the
   * caller resolves the current season's shard before showing AuctionScene.
   * Online only — appears in the right-side strip alongside Daily/Mail/Events.
   */
  onOpenAuction?(): void;
  /**
   * SLG soft gate (ONBOARDING_DESIGN §4): true when chapter one is not yet cleared →
   * the world map entry is greyed out; tapping shows a "clear chapter one to unlock"
   * bubble instead of navigating. Becomes false once the chapter is cleared.
   */
  worldLocked?: boolean;
  /** Open the shop (economy). Wired to the bottom-nav "shop" slot (S2-6). */
  onOpenShop(): void;
  /** Tapping the header coin balance jumps straight to the shop's recharge (Coins) tab. Online only. */
  onOpenRecharge?(): void;
  /** Tapping the header rank badge jumps straight to the global leaderboard. Online only. */
  onOpenLeaderboard?(): void;
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
  /** Quick shortcut to the mail tab in the social hub (P2 right-strip). Online only. */
  onOpenMail?(): void;
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
  /** Selected avatar token ('0'-'7'); absent = letter-initial fallback. */
  avatarId?: string;
}

export type LobbyState = 'idle' | 'matching' | 'vs';

export type Constructor<T = object> = new (...args: any[]) => T;
export type LobbySceneBaseCtor = Constructor<LobbySceneBase>;

export class LobbySceneBase {
  readonly container: PIXI.Container;

  protected readonly w: number;
  protected readonly h: number;
  protected readonly cb: LobbySceneCallbacks;

  protected state:        LobbyState = 'idle';
  protected matchTimer    = 0;
  protected vsTimer       = 0;
  protected dotsTimer     = 0;
  protected dotCount      = 0;
  protected opponentName  = '';

  protected btnBg!:    PIXI.Graphics;
  protected btnLabel!: PIXI.Text;
  protected vsLayer!:  PIXI.Container;
  protected oppLabel!: PIXI.Text;
  /** Boiling-line title underline (art-direction §5.4); cleaned up in destroy. */
  protected titleBoil: BoilingSprite | null = null;
  /**
   * Ambient silhouette figure stamped on the hero button (mirrors the crossed-pencils
   * motif on the right) — a random playable character, tinted flat black + faded,
   * cycling through random animation clips. Populated once its .tao bundle loads
   * (async), so it's absent for the first render frame or two.
   */
  protected heroFigure: StickmanRuntime | null = null;
  /** Clip names available on the loaded heroFigure asset, for random cycling. */
  protected heroFigureClips: string[] = [];
  /** Countdown (seconds) to the next random clip swap. */
  protected heroFigureSwapTimer = 0;

  /** Hit rect for the start/matching button, in design space. */
  protected btnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the single campaign (PvE) entry button, in design space. */
  protected campaignBtnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the world map (SLG) pillar card — promoted out of the bottom nav into the main layout. */
  protected worldPillarRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the bottom-nav "social" slot (opens RoomScene). */
  protected socialNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the bottom-nav "shop" slot (opens ShopScene). */
  protected shopNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the bottom-nav "cards" slot (opens CollectionScene). */
  protected cardsNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the bottom-nav "stats" slot (opens StatsScene). */
  protected statsNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the top-right account chip (login when offline / logout when on). */
  protected accountChipRect: Rect | null = null;
  protected accountChipFn: (() => void) | null = null;
  /** Hit rect for the header coin balance (opens the shop's recharge tab). Online only. */
  protected coinsChipRect: Rect | null = null;
  /** Hit rect for the header rank badge (opens the leaderboard). Online only. */
  protected rankChipRect: Rect | null = null;
  /** Hit rect for the top-left profile chip (opens SettingsScene). */
  protected profileChipRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  /** Aggregate social unread (friends + chat + mail) → red dot on the social nav slot. */
  protected socialBadge = 0;
  /** Re-drawn layer for the social badge so updates don't rebuild the whole nav bar. */
  protected socialBadgeLayer: PIXI.Container | null = null;
  /** Any achievement tier is claimable (ACHIEVEMENT_DESIGN §4.1) → red dot on the stats nav slot. */
  protected achievementBadge = false;
  /** Re-drawn layer for the achievement dot (cheap refresh, no nav rebuild). */
  protected achievementBadgeLayer: PIXI.Container | null = null;
  /** Retention claimable (B5: checkin or daily reward) → red dot on the daily strip item. */
  protected retentionBadge = false;
  /** Hit rect for the daily strip item. */
  protected dailyBtnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** B6: whether a live event window exists → show the events strip item. */
  protected eventsAvailable = false;
  /** Hit rect for the events strip item. */
  protected eventsBtnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the mail strip item (P2). */
  protected mailStripRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the achievements strip item (P2). */
  protected achieveStripRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  protected auctionStripRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Cheap-refresh layer for the red dots on the right-side strip (daily/mail/achievement). */
  protected sideStripBadgeLayer: PIXI.Container | null = null;
  /** null = not yet checked; true = reachable; false = unreachable → show badge. */
  protected worldOnline: boolean | null = null;
  /** Cheap-refresh layer for the worldsvc-offline indicator on the world nav slot. */
  protected worldOfflineBadgeLayer: PIXI.Container | null = null;
  /** Transient "achievement unlocked" toast (S9-5b): own top-most layer + auto-fade timer + tap-to-open rect. */
  protected toastLayer: PIXI.Container | null = null;
  protected toastTimer = 0;
  protected toastRect: Rect | null = null;
  /** Season-settlement modal overlay (SE-6). Blocks lobby taps until dismissed. */
  protected settlementLayer: PIXI.Container | null = null;
  protected settlementDismissRect: Rect | null = null;
  /** First-time feature guide overlay (ONBOARDING §4.1). After dismissal the callback continues navigation to the feature. */
  protected guideLayer: PIXI.Container | null = null;
  protected guideDismissRect: Rect | null = null;
  protected guideOnDismiss: (() => void) | null = null;
  /** Set on destroy so a late-resolving badge fetch skips touching a dead container. */
  protected destroyed = false;

  protected readonly unsubs: Array<() => void> = [];

  constructor(layout: ILayout, input: InputManager, cb: LobbySceneCallbacks) {
    this.container = new PIXI.Container();
    this.w  = layout.designWidth;
    this.h  = layout.designHeight;
    this.cb = cb;
    this.build();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));

    // Header coin balance uses the shop's AI atlas glyph (buildCoinIcon); rebuild once it's
    // decoded so the lobby doesn't stay stuck on the procedural fallback glyph.
    loadCoinIconAtlas()
      .catch((err) => console.warn('[LobbyScene] coin icon atlas load failed:', err))
      .then(() => { if (!this.destroyed) this.rebuild(); });
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
    if (this.heroFigure) {
      this.heroFigure.update(dt);
      this.heroFigureSwapTimer -= dt;
      if (this.heroFigureSwapTimer <= 0 && this.heroFigureClips.length > 0) {
        this.heroFigureSwapTimer = 1.6 + Math.random() * 1.6;
        const name = this.heroFigureClips[Math.floor(Math.random() * this.heroFigureClips.length)]!;
        this.heroFigure.play(name);
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach(u => u());
    this.titleBoil?.destroy();
    this.titleBoil = null;
    this.heroFigure?.destroy();
    this.heroFigure = null;
    this.socialBadgeLayer = null;
    this.achievementBadgeLayer = null;
    this.sideStripBadgeLayer = null;
    this.toastLayer = null;
    this.toastRect = null;
    this.settlementLayer = null;
    this.settlementDismissRect = null;
  }
}

// ── cross-mixin entrypoints — see FriendsScene/base.ts for why this interface-merge exists:
// it lets base-level code (constructor/update) and same-layer mixins call methods that live in
// sibling mixin files (invisible to each other and to base) as real METHOD calls, emitting
// nothing at runtime — the actual prototype methods provided by the mixins run unchanged.
export interface LobbySceneBase {
  build(): void;
  handleDown(x: number, y: number): void;
  onStartPressed(): void;
  matchFound(): void;
  drawSocialBadge(): void;
  drawAchievementBadge(): void;
  drawWorldOfflineBadge(): void;
  drawSideStripBadges(): void;
  rebuild(): void;
  clearGuide(): void;
  clearSettlement(): void;
  clearToast(): void;
  showInfoToast(text: string, icon?: IconKind): void;
}
