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
// resolved (rebuild() moved to Core; this file no longer has any back-edge from either sibling).
import * as PIXI from 'pixi.js-legacy';
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

  handleDown(x: number, y: number): void {
    const core = this.core;
    if (core.state !== 'idle') return;
    // First-time feature guide (§4.1): any tap dismisses it and continues navigation. Checked before other hits.
    if (core.guideLayer) {
      this.overlays.clearGuide();
      return;
    }
    // Season settlement modal (SE-6): dismiss button or anywhere on backdrop dismisses it.
    if (core.settlementLayer) {
      this.overlays.clearSettlement();
      return;
    }
    // Achievement-unlock toast tap → jump to the wall (S9-5b). Checked first so it wins over nav slots.
    const tr = core.toastRect;
    if (tr && x >= tr.x && x <= tr.x + tr.w && y >= tr.y && y <= tr.y + tr.h) {
      const open = core.cb.onOpenAchievements;
      this.overlays.clearToast();
      if (open) open();
      return;
    }
    const p = core.profileChipRect;
    if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) {
      core.cb.onOpenProfile();
      return;
    }
    if (x >= core.btnRect.x && x <= core.btnRect.x + core.btnRect.w &&
        y >= core.btnRect.y && y <= core.btnRect.y + core.btnRect.h) {
      onStartPressed(core);
      return;
    }
    const camp = core.campaignBtnRect;
    if (x >= camp.x && x <= camp.x + camp.w && y >= camp.y && y <= camp.y + camp.h) {
      core.cb.onOpenCampaign();
      return;
    }
    // World map (SLG) pillar — promoted out of the bottom nav into the main layout.
    const wp = core.worldPillarRect;
    if (wp.w > 0 && x >= wp.x && x <= wp.x + wp.w && y >= wp.y && y <= wp.y + wp.h) {
      // Soft gate (§4): chapter one not cleared → greyed out, tap shows bubble instead of entering.
      if (core.cb.worldLocked) { this.overlays.showInfoToast(t('lobby.world.locked')); return; }
      if (core.cb.onOpenWorld) core.cb.onOpenWorld();
      return;
    }
    const daily = core.dailyBtnRect;
    if (core.cb.onOpenDaily && daily.w > 0 &&
        x >= daily.x && x <= daily.x + daily.w && y >= daily.y && y <= daily.y + daily.h) {
      core.cb.onOpenDaily();
      return;
    }
    const ev = core.eventsBtnRect;
    if (core.cb.onOpenEvents && ev.w > 0 &&
        x >= ev.x && x <= ev.x + ev.w && y >= ev.y && y <= ev.y + ev.h) {
      core.cb.onOpenEvents();
      return;
    }
    const ml = core.mailStripRect;
    if (ml.w > 0 && x >= ml.x && x <= ml.x + ml.w && y >= ml.y && y <= ml.y + ml.h) {
      if (core.cb.onOpenMail) core.cb.onOpenMail();
      else if (core.cb.onOpenSocial) core.cb.onOpenSocial();
      return;
    }
    const fb = core.feedbackStripRect;
    if (fb.w > 0 && x >= fb.x && x <= fb.x + fb.w && y >= fb.y && y <= fb.y + fb.h) {
      if (core.cb.onOpenFeedback) core.cb.onOpenFeedback();
      return;
    }
    const auc = core.auctionStripRect;
    if (auc.w > 0 && x >= auc.x && x <= auc.x + auc.w && y >= auc.y && y <= auc.y + auc.h) {
      if (core.cb.onOpenAuction) core.cb.onOpenAuction();
      return;
    }
    const acc = core.accountChipRect;
    if (acc && core.accountChipFn &&
        x >= acc.x && x <= acc.x + acc.w && y >= acc.y && y <= acc.y + acc.h) {
      core.accountChipFn();
      return;
    }
    const coinsChip = core.coinsChipRect;
    if (coinsChip && core.cb.onOpenRecharge &&
        x >= coinsChip.x && x <= coinsChip.x + coinsChip.w && y >= coinsChip.y && y <= coinsChip.y + coinsChip.h) {
      core.cb.onOpenRecharge();
      return;
    }
    const rankChip = core.rankChipRect;
    if (rankChip && core.cb.onOpenLeaderboard &&
        x >= rankChip.x && x <= rankChip.x + rankChip.w && y >= rankChip.y && y <= rankChip.y + rankChip.h) {
      core.cb.onOpenLeaderboard();
      return;
    }
    // Bottom-nav center slot is now "home" (the lobby itself) — current page, no-op.
    // Shop + social slots are only drawn when online (offline omits them entirely),
    // so a zero-width rect here means the slot is absent — guard with w > 0.
    const s = core.socialNavRect;
    if (s.w > 0 && x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
      if (core.cb.onOpenSocial) core.cb.onOpenSocial();
      else core.cb.onOpenRoom();
      return;
    }
    const sh = core.shopNavRect;
    if (sh.w > 0 && x >= sh.x && x <= sh.x + sh.w && y >= sh.y && y <= sh.y + sh.h) {
      core.cb.onOpenShop();
      return;
    }
    // Collection reads local save data → works offline; rect always assigned.
    // Stats is online-only now (§6 decision 6) → its rect is unassigned (w=0) offline.
    const cd = core.cardsNavRect;
    if (cd.w > 0 && x >= cd.x && x <= cd.x + cd.w && y >= cd.y && y <= cd.y + cd.h) {
      core.cb.onOpenCards();
      return;
    }
    const st = core.statsNavRect;
    if (st.w > 0 && x >= st.x && x <= st.x + st.w && y >= st.y && y <= st.y + st.h) {
      core.cb.onOpenStats();
      return;
    }
  }
}
