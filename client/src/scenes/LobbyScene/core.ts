// Shared foundation for the LobbyScene composition (see ../LobbyScene.ts assembly).
//
// LobbySceneCore holds every instance field (all `public`, so the domain classes/free-function
// modules below keep referencing them via `core.xxx`: core.btnRect, core.socialBadge, …) + the
// shared render primitives (txt/fmtCoins/sketchPanel/drawBtn/buildBackground/randomAiName) used
// across the domains. Core does NOT own the Scene interface (update()/destroy() dispatch) — unlike
// every other conversion in this batch, the outer ../LobbyScene.ts assembly owns update()/destroy()
// directly, because the original mixin chain's update() called two different sibling methods by
// name (BuildMixin's matchFound(), OverlaysMixin's clearToast()) rather than a single injected
// callback — only the assembly has references to both siblings (see LobbyScene.ts's file-header
// comment for the full reasoning). Core's own constructor is correspondingly thin: it does NOT run
// the initial layout build() or subscribe input.onDown (both need BuildPanel, which doesn't exist
// yet at Core-construction time) — the assembly does both, in dependency order, right after
// constructing every domain.
//
// One genuine two-phase-construction wrinkle: rebuild() (full teardown + relayout, needed when a
// strip item appears/disappears, or once the coin-icon atlas finishes loading after the first draw)
// only ever touches Core-owned fields except for the final "now redraw everything" step, which is
// BuildPanel's build() — a method that doesn't exist yet when Core's own constructor wires up the
// onSaveChanged/coinIconAtlas listeners that (later, async) need to call it. Resolved via the
// established default-no-op-field two-phase-construction pattern (see client-modules.md): Core
// declares `buildHook` defaulting to a no-op, and the outer assembly overwrites it with the real
// `() => this.build.build()` immediately after constructing BuildPanel, before anything can fire.
//
// One genuine bidirectional dependency surfaced during the conversion: the old build.ts's build()
// called badges.ts's drawSocialBadge()/drawAchievementBadge()/drawShopBadge()/
// drawWorldOfflineBadge()/drawSideStripBadges() (to paint current badge state into the freshly-built
// layers), while badges.ts's applyEventsAvailable() called build.ts's own rebuild() (defined in
// badges.ts, tearing down Core state then calling build()) whenever the events strip item needs to
// appear/disappear. Splitting "paint the badge dots" and "trigger a full relayout" across the same
// two files was the wrong boundary: rebuild() itself doesn't actually belong to the badges domain at
// all — it's a whole-scene concern (the exact same teardown+build() sequence coinIconAtlas and
// onSaveChanged already needed from Core's own constructor), it just happened to live in badges.ts
// because that's where the first caller that needed it (events-strip visibility) was implemented.
// Moving rebuild() here (Core) removes the back-edge entirely: badges.ts now only ever calls
// `this.core.rebuild()` (a plain Core method, same as any other domain would), and build.ts depends
// on badges.ts one-way (calling its draw*Badge methods after constructing fresh layers) like every
// other clean pair in this batch. overlays.ts remains a clean leaf exactly as previously reported —
// re-verified via grep: build.ts calls its clearGuide()/clearSettlement()/clearToast()/
// showInfoToast(), nothing calls back the other way.
//
// LobbyScene — main menu / hub (S2).
import * as PIXI from 'pixi.js-legacy';
import { ILayout, Rect } from '../../layout/ILayout';
import { SketchPen } from '../../render/sketch';
import { palette } from '../../render/theme';
import { bake } from '../../render/bake';
import { BoilingSprite } from '../../render/boil';
import { StickmanRuntime } from '../../render/stickman/StickmanRuntime';
import { loadCoinIconAtlas } from '../../render/atlas/coinIconAtlas';
import { preloadTabIconTextures } from '../../render/icons';
import { makeText } from '../../render/pixiText';
import { tearDownChildren } from '../../render/sketchUi';

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
  /**
   * Header + bottom-nav fill. Deliberately a shade off `C.dark` (not identical) so
   * the two chrome bars don't read as the exact same block as the START MATCH
   * button between them — same dark family, just a hair warmer/lighter, enough to
   * separate "frame" from "action" without introducing a loud accent color there.
   */
  cover:  0x3a352f,
  mid:    0x888888,
  light:  0xdddddd,
  btnOff: 0xbbbbbb,
  accent: 0x4477cc,
  gold:   0xcc9900,
  green:  0x4a9e4a,
  red:    0xcc3333,
};

/** Ladder-tier accent color, keyed by `pvp.rank`. Gives the rank badge its own
 * color identity per tier instead of borrowing the currency gold or a flat
 * grey — falls back to `C.mid` for `unranked`/unknown tiers. */
export const TIER_COLORS: Record<string, number> = {
  unranked: 0x999999,
  bronze:   0xb3652e,
  silver:   0x9aa3ab,
  gold:     0xd9a520,
  platinum: 0x4fb8ac,
  diamond:  0x5bb8e8,
  master:   0xb377e0,
};

export function txt(label: string, size: number, color: number, bold = false): PIXI.Text {
  return makeText(label, {
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
   * true; otherwise the start button falls back to the local AI quick-match.
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
  /**
   * Open the in-game feedback panel (UI_DESIGN.md §4.1.1). Right-side strip entry, replacing the
   * low-usage achievement shortcut there (2026-08-04) — the achievement wall is still reachable via
   * the Career hub tabs and the unlock toast (onOpenAchievements above), so nothing is lost.
   */
  onOpenFeedback?(): void;
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
  /**
   * Live soft-currency balance getter (SaveData.wallet.coins mirror); shown in the header (online only).
   * A closure rather than a snapshot value so the header re-renders with the current balance instead of
   * whatever it was at the moment `showLobby` was called (matches the getCoins convention used by every
   * other nav module — see nav/world.ts/shop.ts/social.ts).
   */
  getCoins?(): number;
  /** Subscribe to SaveManager writes; rebuilds the header when the wallet changes elsewhere (e.g. a purchase in a screen navigated away from and back via resize). Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
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

export class LobbySceneCore {
  readonly container: PIXI.Container;

  readonly w: number;
  readonly h: number;
  /** True in portrait; landscape keeps the original single-row header (see build.ts's header block). */
  readonly portrait: boolean;
  readonly cb: LobbySceneCallbacks;

  state:        LobbyState = 'idle';
  matchTimer    = 0;
  vsTimer       = 0;
  dotsTimer     = 0;
  dotCount      = 0;
  opponentName  = '';

  btnBg!:    PIXI.Graphics;
  btnLabel!: PIXI.Text;
  vsLayer!:  PIXI.Container;
  oppLabel!: PIXI.Text;
  /** Boiling-line title underline (art-direction §5.4); cleaned up in destroy. */
  titleBoil: BoilingSprite | null = null;
  /**
   * Ambient silhouette figure stamped on the hero button (mirrors the crossed-pencils
   * motif on the right) — a random playable character, tinted flat black + faded,
   * cycling through random animation clips. Populated once its .tao bundle loads
   * (async), so it's absent for the first render frame or two.
   */
  heroFigure: StickmanRuntime | null = null;
  /** Clip names available on the loaded heroFigure asset, for random cycling. */
  heroFigureClips: string[] = [];
  /** Countdown (seconds) to the next random clip swap. */
  heroFigureSwapTimer = 0;

  /** Hit rect for the start/matching button, in design space. */
  btnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the single campaign (PvE) entry button, in design space. */
  campaignBtnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the world map (SLG) pillar card — promoted out of the bottom nav into the main layout. */
  worldPillarRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the bottom-nav "social" slot (opens RoomScene). */
  socialNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the bottom-nav "shop" slot (opens ShopScene). */
  shopNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the bottom-nav "cards" slot (opens CardScene, the Hero Roster). */
  cardsNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the bottom-nav "stats" slot (opens StatsScene). */
  statsNavRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the top-right account chip (login when offline / logout when on). */
  accountChipRect: Rect | null = null;
  accountChipFn: (() => void) | null = null;
  /** Hit rect for the header coin balance (opens the shop's recharge tab). Online only. */
  coinsChipRect: Rect | null = null;
  /** Hit rect for the header rank badge (opens the leaderboard). Online only. */
  rankChipRect: Rect | null = null;
  /** Hit rect for the top-left profile chip (opens SettingsScene). */
  profileChipRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  /** Aggregate social unread (friends + chat + mail) → red dot on the social nav slot. */
  socialBadge = 0;
  /** Mail-only unread count → red dot on the dedicated mail strip item (must not include friend/chat unread). */
  mailBadge = 0;
  /** Re-drawn layer for the social badge so updates don't rebuild the whole nav bar. */
  socialBadgeLayer: PIXI.Container | null = null;
  /** Any achievement tier is claimable (ACHIEVEMENT_DESIGN §4.1) → red dot on the stats nav slot. */
  achievementBadge = false;
  /** Re-drawn layer for the achievement dot (cheap refresh, no nav rebuild). */
  achievementBadgeLayer: PIXI.Container | null = null;
  /** Monthly/year card active with today's daily reward unclaimed → red dot on the shop nav slot. */
  shopBadge = false;
  /** Re-drawn layer for the shop dot (cheap refresh, no nav rebuild). */
  shopBadgeLayer: PIXI.Container | null = null;
  /** Retention claimable (B5: checkin or daily reward) → red dot on the daily strip item. */
  retentionBadge = false;
  /** Hit rect for the daily strip item. */
  dailyBtnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** B6: whether a live event window exists → show the events strip item. */
  eventsAvailable = false;
  /** Hit rect for the events strip item. */
  eventsBtnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the mail strip item (P2). */
  mailStripRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Hit rect for the achievements strip item (P2). */
  feedbackStripRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  auctionStripRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Cheap-refresh layer for the red dots on the right-side strip (daily/mail/achievement). */
  sideStripBadgeLayer: PIXI.Container | null = null;
  /** null = not yet checked; true = reachable; false = unreachable → show badge. */
  worldOnline: boolean | null = null;
  /** Cheap-refresh layer for the worldsvc-offline indicator on the world nav slot. */
  worldOfflineBadgeLayer: PIXI.Container | null = null;
  /** Transient "achievement unlocked" toast (S9-5b): own top-most layer + auto-fade timer + tap-to-open rect. */
  toastLayer: PIXI.Container | null = null;
  toastTimer = 0;
  toastRect: Rect | null = null;
  /** Season-settlement modal overlay (SE-6). Blocks lobby taps until dismissed. */
  settlementLayer: PIXI.Container | null = null;
  settlementDismissRect: Rect | null = null;
  /** First-time feature guide overlay (ONBOARDING §4.1). After dismissal the callback continues navigation to the feature. */
  guideLayer: PIXI.Container | null = null;
  guideDismissRect: Rect | null = null;
  guideOnDismiss: (() => void) | null = null;
  /** Set on destroy so a late-resolving badge fetch skips touching a dead container. */
  destroyed = false;

  readonly unsubs: Array<() => void> = [];

  /** Set by the outer LobbyScene assembly right after constructing BuildPanel — rebuild() needs to
   *  invoke the full layout rebuild, which lives on a sibling domain Core can't reference at its own
   *  construction time (two-phase construction; see client-modules.md's default-no-op-field
   *  pattern, same shape as SectSceneCore's allianceHooks / DefenseEditorSceneCore's handlers). */
  buildHook: () => void = () => {};

  constructor(layout: ILayout, cb: LobbySceneCallbacks) {
    this.container = new PIXI.Container();
    this.w  = layout.designWidth;
    this.h  = layout.designHeight;
    this.portrait = layout.orientation === 'portrait';
    this.cb = cb;

    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => { if (!this.destroyed) this.rebuild(); }));

    // Header coin balance uses the shop's AI atlas glyph (buildCoinIcon); rebuild once it's
    // decoded so the lobby doesn't stay stuck on the procedural fallback glyph.
    loadCoinIconAtlas()
      .catch((err) => console.warn('[LobbyScene] coin icon atlas load failed:', err))
      .then(() => { if (!this.destroyed) this.rebuild(); });

    // Same deal for the bottom nav's five AI tab glyphs — `buildIcon` draws nothing for a raster
    // kind whose texture hasn't decoded (icons.ts), so on a cold first load the nav rendered
    // label-only until some unrelated event happened to rebuild. Warming here also covers every
    // scene entered FROM the lobby: `Texture.from` is url-keyed, so their title-bar and tab-strip
    // glyphs (scene-title icon pass) are already decoded by the time they draw, which matters most
    // for the ones that render exactly once and never redraw (settings / level prep / room).
    preloadTabIconTextures()
      .catch((err) => console.warn('[LobbyScene] tab icon preload failed:', err))
      .then(() => { if (!this.destroyed) this.rebuild(); });
  }

  /**
   * Full teardown + rebuild — needed when a layout element (strip item) appears or changes, or
   * when the coin-icon atlas finishes loading after the first draw. titleBoil / heroFigure are
   * Ticker.shared-driven and hold sprites that tearDownChildren() is about to destroy — destroy
   * them explicitly first, same as destroy(), so their next tick doesn't touch a dead PIXI object
   * (that used to freeze the scene's update loop — see test/render/lobbyRebuildTeardown.test.ts).
   */
  rebuild(): void {
    this.titleBoil?.destroy();
    this.titleBoil = null;
    this.heroFigure?.destroy();
    this.heroFigure = null;
    this.heroFigureClips = [];
    this.heroFigureSwapTimer = 0;
    tearDownChildren(this.container);
    this.toastLayer = null;
    this.settlementLayer = null;
    this.achievementBadgeLayer = null;
    this.shopBadgeLayer = null;
    this.socialBadgeLayer = null;
    this.sideStripBadgeLayer = null;
    this.buildHook();
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
    // Tear the page tree down too. titleBoil / heroFigure (the Ticker.shared-driven
    // children) were destroyed explicitly above; this frees the remaining static
    // children so nothing outlives the scene. All async repaint paths (badges /
    // overlays / rebuild) already early-return on `this.destroyed`.
    this.container.destroy({ children: true });
  }
}
