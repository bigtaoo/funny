// GameRenderer — purely visual + InputManager-driven battle renderer. Thin assembly file.
//
// The renderer is split by domain — each part lives in ./GameRenderer/*.ts and is composed here over
// GameRendererCore (./GameRenderer/core.ts, which owns all instance state + the scene-graph builder +
// the update/destroy lifecycle). To add a handler: find the matching domain class (input drag/tap-
// select in ./GameRenderer/input.ts, event/VFX dispatch in ./GameRenderer/events.ts) — do NOT grow
// this file. GameProfiles is re-exported so existing importers (`from './GameRenderer'`) keep
// resolving to this file, not the directory.
//
// 2026-08-11: converted from the former `EventMixin(InputMixin(GameRendererBase))` inheritance chain
// to composition — see claudedocs/client-modules.md's split-form priority note. Core wires its own
// InputManager onDown/onMove/onUp subscriptions (closures resolved once `core.input` is set below —
// see core.ts's file-header comment); this assembly's job is to construct the three pieces in order,
// cross-wire the `events`/`input` back-references Core needs, then own the update() dispatch that
// used to flow through the mixin chain (InputMixin's `update` override ran its own body AFTER
// Base's via `super.update()` — replicated below as `core.update()` then `input.update()`, same
// order). Most of the pre-existing public API (onGameEnd, setCampaignMode, isGameOver, vignetteAlpha,
// …) is forwarded straight through to `core`/`events` so GameScene.ts/ReplayScene.ts don't need to
// change.
import type { IGameEngine, MatchSummary, OwnerId, PlayerStats } from './../game';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { EngineCardInstance, EngineEquipInv } from '@nw/engine';
import type { BattleLabelContext } from './battleLabels';
import { GameRendererCore } from './GameRenderer/core';
import type { GameProfiles } from './GameRenderer/core';
import { EventsPanel } from './GameRenderer/events';
import { InputPanel } from './GameRenderer/input';

export type { GameProfiles } from './GameRenderer/core';

/**
 * GameRenderer — the battle scene renderer, thin assembly over the per-domain composition (see the
 * file-header comment above).
 */
export class GameRenderer {
  readonly container;

  private readonly core: GameRendererCore;
  private readonly events: EventsPanel;
  private readonly input: InputPanel;

  constructor(
    engine: IGameEngine,
    layout: ILayout,
    input: InputManager,
    netEnabled = false,
    spectator = false,
    profiles: GameProfiles = {},
    equippedSkins: readonly string[] = [],
    cardInstances: EngineCardInstance[] | null = null,
    equipmentInv: EngineEquipInv | null = null,
    tutorial = false,
    battleLabels: BattleLabelContext = {},
    replayNames: readonly [string, string] | null = null,
    opponentSkins: readonly string[] = [],
  ) {
    this.core = new GameRendererCore(
      engine, layout, input, netEnabled, spectator, profiles, equippedSkins,
      cardInstances, equipmentInv, tutorial, battleLabels, replayNames, opponentSkins,
    );
    this.container = this.core.container;
    this.events = new EventsPanel(this.core);
    this.core.events = this.events; // wire the lazy `events` back-reference now that EventsPanel exists
    this.input = new InputPanel(this.core);
    this.core.input = this.input;   // wire the lazy `input` back-reference now that InputPanel exists
  }

  // ── Public API — forwarded to Core/EventsPanel (see file-header comment) ─────

  get onGameEnd(): ((winner: OwnerId | null, stats: [PlayerStats, PlayerStats], summary: MatchSummary) => void) | null {
    return this.core.onGameEnd;
  }
  set onGameEnd(fn: ((winner: OwnerId | null, stats: [PlayerStats, PlayerStats], summary: MatchSummary) => void) | null) {
    this.core.onGameEnd = fn;
  }
  get onExitToLobby(): (() => void) | null { return this.core.onExitToLobby; }
  set onExitToLobby(fn: (() => void) | null) { this.core.onExitToLobby = fn; }
  get onTutorialStep(): ((stepKey: string) => void) | null { return this.core.onTutorialStep; }
  set onTutorialStep(fn: ((stepKey: string) => void) | null) { this.core.onTutorialStep = fn; }

  /** Screen-edge base-damage flash alpha — read/reset directly by ReplayScene when playback stops. */
  get vignetteAlpha(): number { return this.events.vignetteAlpha; }
  set vignetteAlpha(v: number) { this.events.vignetteAlpha = v; }
  drawVignette(): void { this.events.drawVignette(); }

  setCampaignMode(v: boolean): void { this.core.setCampaignMode(v); }
  setReconnecting(v: boolean): void { this.core.setReconnecting(v); }
  setPeerDisconnected(v: boolean): void { this.core.setPeerDisconnected(v); }
  setDisconnected(v: boolean): void { this.core.setDisconnected(v); }
  clearNetStatus(): void { this.core.clearNetStatus(); }
  isGameOver(): boolean { return this.core.isGameOver(); }
  get currentTick(): number { return this.core.currentTick; }
  snapshotStats(): [PlayerStats, PlayerStats] { return this.core.snapshotStats(); }
  get controlledOwner(): OwnerId { return this.core.controlledOwner; }

  init(): void { this.core.init(); }

  update(dt: number): void {
    this.core.update(dt);
    this.input.update(dt);
  }

  destroy(): void { this.core.destroy(); }
}
