// LobbyScene — main menu / hub (S2). Thin assembly file.
//
// The scene is split by domain — each part lives in ./LobbyScene/*.ts and is composed here over
// LobbySceneCore (./LobbyScene/core.ts, which owns all instance state + the shared render
// primitives, but NOT the Scene interface — see core.ts's header comment for why). To add a
// handler: find the matching domain class (build / badges / overlays) or one of build's own
// secondary-split sub-modules (header/mainContent/bottomNav/vsOverlay/matchState) — do NOT grow
// this file. LobbySceneCallbacks is re-exported so existing importers (`from './LobbyScene'`) keep
// resolving to this file, not the directory.
//
// 2026-08-12: converted from the former `XMixin(Base)` inheritance chain to composition — see
// claudedocs/client-modules.md's split-form priority note. update()/destroy() dispatch lives here
// (unlike most conversions in this batch, where Core keeps owning update()/destroy()) because the
// original mixin chain's update() called two *different* sibling methods by name (matchFound() on
// the old BuildMixin, clearToast() on the old OverlaysMixin) rather than a single injected render
// callback — only this assembly has references to both BuildPanel and OverlaysPanel. The initial
// synchronous build() call and the input.onDown subscription move here for the same reason: they
// need BuildPanel, which doesn't exist yet when Core's own constructor runs. See
// ./LobbyScene/core.ts's file-header comment for how the one genuine bidirectional dependency found
// during the conversion (the old build.ts↔badges.ts pair around rebuild()) was resolved.
import { Scene } from './SceneManager';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { LobbySceneCore, type LobbySceneCallbacks } from './LobbyScene/core';
import { BuildPanel } from './LobbyScene/build';
import { BadgesPanel } from './LobbyScene/badges';
import { OverlaysPanel } from './LobbyScene/overlays';
import { matchFound } from './LobbyScene/matchState';

export type { LobbySceneCallbacks } from './LobbyScene/core';

/**
 * LobbyScene — the main hub scene registered against SceneManager.
 * Assembled from the per-domain composition (see the file-header comment above).
 */
export class LobbyScene implements Scene {
  readonly container;

  private readonly core: LobbySceneCore;
  private readonly overlays: OverlaysPanel;
  private readonly badges: BadgesPanel;
  private readonly build: BuildPanel;
  /** Owns its own input.onDown subscription (rather than pushing into core.unsubs) so the
   *  subscribe/drain pair stays within one file — see
   *  test/input-subscription-cleanup.test.ts's static per-file convention check. */
  private readonly unsubs: Array<() => void> = [];

  constructor(layout: ILayout, input: InputManager, cb: LobbySceneCallbacks) {
    this.core = new LobbySceneCore(layout, cb);
    this.container = this.core.container;
    this.overlays = new OverlaysPanel(this.core);
    this.badges = new BadgesPanel(this.core);
    this.build = new BuildPanel(this.core, this.badges, this.overlays);
    // Two-phase construction: Core's rebuild() (already wired to fire from its own constructor via
    // onSaveChanged/preloadTabIconTextures) needs to call BuildPanel.build(), which didn't exist yet
    // when Core was constructed above — wire the hook now, before anything async can fire it.
    this.core.buildHook = () => this.build.build();

    // Paint the full layout on the same frame the scene mounts (mirrors the old mixin chain's
    // constructor-time this.build() call).
    this.build.build();
    this.unsubs.push(input.onDown((x, y) => this.build.handleDown(x, y)));
  }

  update(dt: number): void {
    const core = this.core;
    if (core.state === 'matching') {
      core.matchTimer += dt;
      core.dotsTimer  += dt;
      if (core.dotsTimer >= 0.4) {
        core.dotsTimer = 0;
        core.dotCount  = (core.dotCount + 1) % 4;
        core.btnLabel.text = t('lobby.matching') + '.'.repeat(core.dotCount);
      }
      if (core.matchTimer >= 1.8) matchFound(core);
    } else if (core.state === 'vs') {
      core.vsTimer += dt;
      if (core.vsTimer >= 2.5) core.cb.onStartGame(core.opponentName);
    }
    if (core.toastTimer > 0) {
      core.toastTimer -= dt;
      if (core.toastTimer <= 0) this.overlays.clearToast();
      else if (core.toastLayer) core.toastLayer.alpha = Math.min(1, core.toastTimer / 0.4);
    }
    if (core.heroFigure) {
      core.heroFigure.update(dt);
      core.heroFigureSwapTimer -= dt;
      if (core.heroFigureSwapTimer <= 0 && core.heroFigureClips.length > 0) {
        core.heroFigureSwapTimer = 1.6 + Math.random() * 1.6;
        const name = core.heroFigureClips[Math.floor(Math.random() * core.heroFigureClips.length)]!;
        core.heroFigure.play(name);
      }
    }
  }

  destroy(): void {
    this.unsubs.forEach(u => u());
    this.core.destroy();
  }

  // ── AppViews.LobbyView surface — delegates to the owning domain ─────────────────────────────

  applySocialBadge(total: number, mail: number): void { this.badges.applySocialBadge(total, mail); }
  applyAchievementBadge(claimable: boolean): void { this.badges.applyAchievementBadge(claimable); }
  applyShopBadge(claimable: boolean): void { this.badges.applyShopBadge(claimable); }
  applyRetentionBadge(claimable: boolean): void { this.badges.applyRetentionBadge(claimable); }
  applyEventsAvailable(available: boolean): void { this.badges.applyEventsAvailable(available); }
  applyWorldAvailable(ok: boolean): void { this.badges.applyWorldAvailable(ok); }
  showAchievementToast(text: string): void { this.overlays.showAchievementToast(text); }
  showSeasonSettlement(oldNo: number, peakRank: string, newNo: number): void {
    this.overlays.showSeasonSettlement(oldNo, peakRank, newNo);
  }
  showFeatureGuide(titleKey: TranslationKey, bodyKey: TranslationKey, onDismiss: () => void): void {
    this.overlays.showFeatureGuide(titleKey, bodyKey, onDismiss);
  }
}
