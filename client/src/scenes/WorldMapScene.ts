// WorldMapScene — SLG overworld map scene (S8). Thin orchestrator over an MVC split:
//   • WorldMapContext  — shared mutable state (pan/zoom/tiles/layers/hit-rects) + callbacks.
//   • WorldMapRenderer — map/tile rendering (pool, city sprites, fog, overlay, L3) + view transforms.
//   • WorldMapPanels   — chrome UI: HUD bar, modals/toasts, deploy dialog, train + world-info panels.
//   • WorldMapNet      — worldsvc API calls, march actions, and live-push handlers.
//   • WorldMapInput    — pointer handling (drag-to-pan) + tile-click action dispatch.
// This class wires them together and satisfies the Scene + WorldMapView (push) contracts.
//
// 300×300+ grid with viewport clipping + drag-to-pan. Only tiles inside the visible window are
// rendered each frame; tile data is fetched on demand and cached. See design/game/SLG_DESIGN.md.

import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { Scene } from './SceneManager';
import type { MarchUpdate, TileUpdate, UnderAttack, SiegeResult } from '../net/proto/transport';
import { WorldMapContext, type WorldMapCallbacks } from './worldmap/WorldMapContext';
import { WorldMapRenderer } from './worldmap/WorldMapRenderer';
import { WorldMapPanels } from './worldmap/WorldMapPanels';
import { WorldMapNet } from './worldmap/WorldMapNet';
import { WorldMapInput } from './worldmap/WorldMapInput';

export type { WorldMapCallbacks, WorldMapView } from './worldmap/WorldMapContext';

export class WorldMapScene implements Scene {
  private readonly ctx: WorldMapContext;

  constructor(layout: ILayout, input: InputManager, cb: WorldMapCallbacks) {
    const ctx = new WorldMapContext(layout, cb);
    ctx.view = new WorldMapRenderer(ctx);
    ctx.panels = new WorldMapPanels(ctx);
    ctx.net = new WorldMapNet(ctx);
    ctx.input = new WorldMapInput(ctx);
    this.ctx = ctx;

    ctx.view.build();
    void ctx.net.loadData();

    ctx.unsubs.push(input.onDown((x, y) => ctx.input.handleDown(x, y)));
    ctx.unsubs.push(input.onMove((x, y) => ctx.input.handleMove(x, y)));
    ctx.unsubs.push(input.onUp((x, y) => ctx.input.handleUp(x, y)));

    // Center map on join initially; will be overridden once we know base location.
    ctx.view.centerAt(Math.floor(ctx.mapW / 2), Math.floor(ctx.mapH / 2));

    ctx.net.start();
    ctx.view.bootstrap();
  }

  get container() { return this.ctx.container; }

  update(dt: number): void { this.ctx.view.update(dt); }

  // ── Live push (worldsvc → gateway → NetSession → here, §14.5) ────────────────
  applyMarchUpdate(m: MarchUpdate): void { this.ctx.net.applyMarchUpdate(m); }
  applyTileUpdate(tu: TileUpdate): void { this.ctx.net.applyTileUpdate(tu); }
  applyUnderAttack(u: UnderAttack): void { this.ctx.net.applyUnderAttack(u); }
  applySiegeResult(s: SiegeResult): void { this.ctx.net.applySiegeResult(s); }

  destroy(): void {
    this.ctx.destroyed = true;
    this.ctx.net.destroy();
    this.ctx.view.destroy();
    for (const u of this.ctx.unsubs) u();
    this.ctx.unsubs.length = 0;
    this.ctx.container.destroy({ children: true });
  }
}
