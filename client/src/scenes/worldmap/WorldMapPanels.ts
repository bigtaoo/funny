// WorldMapPanels — every panel/overlay the world map draws on top of the tile layers.
// Thin assembly file.
//
// The class is split by panel domain — each part lives in ./WorldMapPanels/*.ts as an
// independent class constructed with the shared `WorldMapPanelsCore` (./WorldMapPanels/core.ts,
// which owns the single `ctx` field plus the modal/toast/deploy primitives and the panel-chrome
// helpers every panel draws itself with). To add a panel: find the matching domain class
// (hud / shop / territory / replay), add the method there + its matching one-line forward below,
// or add a new domain file — do NOT grow the domain logic into this file. WorldMapPanels stays
// exported HERE so importers (`from './WorldMapPanels'`) keep resolving to this file, not the
// directory.
//
// 2026-08-11: converted from the former `XMixin(Base)` inheritance chain to composition — zero
// cross-domain `this.*` calls (pure file-splitting via a chain, see claudedocs/client-modules.md's
// split-form priority note). `WorldMapPanels` is now a thin forwarding facade rather than an
// `extends` chain — every method here exists because WorldMapInput/WorldMapNet/WorldMapRenderer
// already call `ctx.panels.methodName(...)` directly and must keep resolving.
import { WorldMapPanelsCore } from './WorldMapPanels/core';
import { HudPanel } from './WorldMapPanels/hud';
import { ShopPanel } from './WorldMapPanels/shop';
import { TerritoryPanel } from './WorldMapPanels/territory';
import { ReplayPanel } from './WorldMapPanels/replay';
import type { WorldMapContext, DeployKind } from './WorldMapContext';
import type { SlgShopItemView } from '../../net/WorldApiClient';

/**
 * WorldMapPanels — the world map's panel layer, thin forwarding facade over the per-domain
 * composition (see the file-header comment above). Constructed as `new WorldMapPanels(ctx)` by
 * WorldMapScene.
 */
export class WorldMapPanels {
  private readonly core: WorldMapPanelsCore;
  private readonly hud: HudPanel;
  private readonly shop: ShopPanel;
  private readonly territory: TerritoryPanel;
  private readonly replay: ReplayPanel;

  constructor(ctx: WorldMapContext) {
    this.core = new WorldMapPanelsCore(ctx);
    this.hud = new HudPanel(this.core);
    this.shop = new ShopPanel(this.core);
    this.territory = new TerritoryPanel(this.core);
    this.replay = new ReplayPanel(this.core);
  }

  // ── core: modal/toast/deploy primitives (./WorldMapPanels/core.ts) ───────
  showModal(
    lines: string[],
    buttons: { label: string; action: () => void; disabled?: boolean }[]
  ): void {
    this.core.showModal(lines, buttons);
  }

  closeModal(): void {
    this.core.closeModal();
  }

  showToast(msg: string, color?: number): void {
    this.core.showToast(msg, color);
  }

  showDeployDialog(tx: number, ty: number, kind: DeployKind): void {
    this.core.showDeployDialog(tx, ty, kind);
  }

  // ── hud (./WorldMapPanels/hud.ts) ─────────────────────────────────────────
  renderHud(): void {
    this.hud.renderHud();
  }

  // ── shop (./WorldMapPanels/shop.ts) ───────────────────────────────────────
  shopLabel(it: SlgShopItemView): string {
    return this.shop.shopLabel(it);
  }

  openShopPanel(): void {
    this.shop.openShopPanel();
  }

  renderShopPanel(): void {
    this.shop.renderShopPanel();
  }

  // ── territory (./WorldMapPanels/territory.ts) ─────────────────────────────
  loadWorldTabData(): void {
    this.territory.loadWorldTabData();
  }

  openTerritoryPanel(): void {
    this.territory.openTerritoryPanel();
  }

  renderTerritoryPanel(): void {
    this.territory.renderTerritoryPanel();
  }

  openRenameInput(capitalIdx: number, current: string): void {
    this.territory.openRenameInput(capitalIdx, current);
  }

  // ── replay (./WorldMapPanels/replay.ts) ───────────────────────────────────
  openReplayPanel(): void {
    this.replay.openReplayPanel();
  }

  renderReplayPanel(): void {
    this.replay.renderReplayPanel();
  }
}
