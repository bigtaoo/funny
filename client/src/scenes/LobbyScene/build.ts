// Layout domain: build() orchestrates the header/main-content/bottom-nav/VS-overlay sub-modules
// (2026-08-12 secondary split — see header.ts/mainContent.ts/bottomNav.ts/vsOverlay.ts/matchState.ts
// file-header comments), plus the tap-routing handleDown() dispatcher. This used to be, by far, the
// largest file in the whole mixin→composition batch (807 lines) — the sub-modules above pulled out
// every self-contained visual section that had no cross-cutting need to stay here; what's left is
// genuinely "the layout root": the top-level build() sequence and the single dispatcher that reads
// every hit rect those sub-modules populate on Core.
//
// Depends one-way on BadgesPanel (build() calls its draw*Badge methods right after constructing
// fresh layers so a rebuild doesn't lose the current badge state) and OverlaysPanel (handleDown
// dispatches guide/settlement/toast dismissal and the world-lock info bubble through it) — see
// ./core.ts's file-header comment for how the old bidirectional build.ts↔badges.ts pair was
import { t } from '../../i18n';
import { buildWearOverlay } from '../../render/wearOverlay';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { type LobbySceneCore, buildBackground } from './core';
import type { BadgesPanel } from './badges';
import type { OverlaysPanel } from './overlays';
import { drawHeaderChrome } from './header';
import { drawMainContent } from './mainContent';
import { drawBottomNav } from './bottomNav';
import { buildVsLayer } from './vsOverlay';
import { onStartPressed } from './matchState';
import { dispatchHit, runHit, type Hit } from '../../ui/hits';
import type { Rect } from '../../layout/ILayout';

export class BuildPanel {
  constructor(
    private readonly core: LobbySceneCore,
    private readonly badges: BadgesPanel,
    private readonly overlays: OverlaysPanel,
  ) {}

  // ── Build ──────────────────────────────────────────────────────────────────

  build(): void {
    const core = this.core;
    const { w, h } = core;

    // Background — procedural notebook paper (sketch.ts), baked once per size.
    core.container.addChild(buildBackground(w, h));

    // C-group background doodles (art-direction §6.2): scattered over the paper
    // at very low alpha, below the wear overlay and all UI content.
    const decoC = buildDecorCLayer(w, h);
    if (decoC) core.container.addChild(decoC);

    // Worn-notebook overlay (art-direction §3.1) — faint grain/creases over the
    // page, below the header/panels so it never hurts UI readability.
    const wear = buildWearOverlay(w, h);
    wear.alpha = 0.55;
    core.container.addChild(wear);

    // Header block (logo/title lockup, profile chip, account/coin/rank chips).
    drawHeaderChrome(core);

    // Main content stack: hero start button + campaign/world pillars + right-side strip.
    drawMainContent(core, this.badges);

    // Bottom nav (five fixed slots) + the badge layers drawn over it/the world pillar.
    drawBottomNav(core, this.badges);

    // VS overlay
    core.vsLayer = buildVsLayer(core);
    core.vsLayer.visible = false;
    core.container.addChild(core.vsLayer);
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /**
   * Tap routing. Was a hand-written chain of 18 `if (x >= r.x && …) { …; return; }` blocks; it is
   * now one `Hit[]` + a single `dispatchHit` (ui/hits.ts), which is also where the lobby's buttons
   * got their tap cue — before that they were as silent as the rest of the PIXI-native family
   * (AUDIO_DESIGN.md §0). Push order below is the old chain's order verbatim and `hitTest` is
   * first-pushed-wins, so precedence is unchanged; a zero-width rect still means "this slot is not
   * drawn right now" (offline, soft-gated, feature absent) and is simply not pushed.
   */
  handleDown(x: number, y: number): void {
    const core = this.core;
    if (core.state !== 'idle') return;
    // First-time feature guide (§4.1): any tap dismisses it and continues navigation. Checked before
    // other hits, and it is a dismissal rather than a button — `back`, and it swallows the tap.
    // Modelled as a Hit rather than a bare playSfx even though there is no rect to test: runHit is
    // the single UI-cue outlet, and `test/uiTapSoundCoverage.test.ts` enforces that literally.
    if (core.guideLayer) {
      runHit({ sound: 'sfx.ui.back', fn: () => this.overlays.clearGuide() });
      return;
    }
    // Season settlement modal (SE-6): dismiss button or anywhere on backdrop dismisses it.
    if (core.settlementLayer) {
      runHit({ sound: 'sfx.ui.back', fn: () => this.overlays.clearSettlement() });
      return;
    }

    const hits: Hit[] = [];
    /** `optional` mirrors the old `w > 0` / callback-present guards: a slot that is not drawn is
     *  not a button. */
    const add = (rect: Rect | null | undefined, fn: (() => void) | null | undefined, opts?: { optional?: boolean; sound?: Hit['sound'] }): void => {
      if (!rect || !fn) return;
      if (opts?.optional && rect.w <= 0) return;
      hits.push({ rect, fn, sound: opts?.sound });
    };

    // Achievement-unlock toast tap → jump to the wall (S9-5b). First so it wins over nav slots.
    add(core.toastRect, () => {
      const open = core.cb.onOpenAchievements;
      this.overlays.clearToast();
      if (open) open();
    });
    add(core.profileChipRect, () => core.cb.onOpenProfile());
    add(core.btnRect, () => onStartPressed(core));
    add(core.campaignBtnRect, () => core.cb.onOpenCampaign());
    // World map (SLG) pillar — promoted out of the bottom nav into the main layout.
    // Soft gate (§4): chapter one not cleared → greyed out, tap shows a bubble instead of entering.
    // That refusal is an error, not a navigation, so it says so.
    add(core.worldPillarRect, () => {
      if (core.cb.worldLocked) { this.overlays.showInfoToast(t('lobby.world.locked')); return; }
      core.cb.onOpenWorld?.();
    }, { optional: true, sound: core.cb.worldLocked ? 'sfx.ui.error' : undefined });
    add(core.dailyBtnRect, core.cb.onOpenDaily && (() => core.cb.onOpenDaily!()), { optional: true });
    add(core.eventsBtnRect, core.cb.onOpenEvents && (() => core.cb.onOpenEvents!()), { optional: true });
    add(core.mailStripRect, () => {
      if (core.cb.onOpenMail) core.cb.onOpenMail();
      else if (core.cb.onOpenSocial) core.cb.onOpenSocial();
    }, { optional: true });
    add(core.feedbackStripRect, core.cb.onOpenFeedback && (() => core.cb.onOpenFeedback!()), { optional: true });
    add(core.auctionStripRect, core.cb.onOpenAuction && (() => core.cb.onOpenAuction!()), { optional: true });
    add(core.accountChipRect, core.accountChipFn && (() => core.accountChipFn!()));
    add(core.coinsChipRect, core.cb.onOpenRecharge && (() => core.cb.onOpenRecharge!()));
    add(core.rankChipRect, core.cb.onOpenLeaderboard && (() => core.cb.onOpenLeaderboard!()));
    // Bottom-nav center slot is now "home" (the lobby itself) — current page, no-op.
    // Shop + social slots are only drawn when online (offline omits them entirely), so a
    // zero-width rect here means the slot is absent.
    add(core.socialNavRect, () => {
      if (core.cb.onOpenSocial) core.cb.onOpenSocial();
      else core.cb.onOpenRoom();
    }, { optional: true });
    add(core.shopNavRect, () => core.cb.onOpenShop(), { optional: true });
    // Collection reads local save data → works offline; rect always assigned.
    // Stats is online-only now (§6 decision 6) → its rect is unassigned (w=0) offline.
    add(core.cardsNavRect, () => core.cb.onOpenCards(), { optional: true });
    add(core.statsNavRect, () => core.cb.onOpenStats(), { optional: true });

    dispatchHit(hits, x, y);
  }
}
