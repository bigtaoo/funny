// DefenseEditorScene — SLG universal half-field deployment editor (S8-9 C3 + G3-2c generalized to offense/defense)
//
// Two modes, distinguished by target.mode:
//
// ① Defense (mode='defense'): edit the defense config for the home base (tileKey='base') or
//    allied/own territory (tileKey='{x}:{y}') = engine LevelDefinition restricted subset (U8/U10) —
//    defender (Top) half garrison + building row defenderBuildings + defenderBaseLevel(0..BASE_UPGRADE_COSTS.length).
//    Save via setDefense (overwrite).
//
// ② Attack (mode='attack', G3-2c §16.2 / A7 §16.5, migrated to CC-3 hero cards 2026-07-17): edit a
//    pre-deployment attack team template — attacker (Bottom) half with hero cards from the player's
//    roster (SaveData.cardInv) pre-placed; no buildings / no base upgrades (attacker places cards
//    only). A card can occupy only one cell (placing it elsewhere moves it); committed troops = sum
//    of each placed card's cardState.currentTroops (server-authoritative ledger, not a client HP
//    slider). Save via getTeams→replace slot→setTeams, entries are {cardInstanceId, col, row}.
//
//    Previously (pre-2026-07-17) this mode used the same raw "collected units" palette as defense
//    mode with a client-side 25%-100% HP slider (ArmyEntry.unitType/initialHp) — that path never
//    touched cardState, so combatMarch.ts's card-army exemption from the flat troop pool never
//    applied to teams built here, causing "team shows troops but march says insufficient troops"
//    (the legacy `pw.troops < troops` gate still fired). See slg-occupy-team-only-troops memory.
//
// "Collected units" constraint (U8, defense mode only): palette only lists unit/building types from
// card definitions (CARD_DEFINITIONS); PvE-only units naturally excluded. During a siege, worldsvc
// runs the engine headless with the attacker army + defender config to compute the authoritative
// result (§16.8).
//
// This file is a thin assembly — see ./DefenseEditorScene/core.ts for the shared state and
// ./DefenseEditorScene/{data,render,input}.ts for the per-domain classes. To add a handler: find the
// matching domain class or add a new one — do NOT grow the domain logic into this file, only its
// one-line dispatch call. DefenseEditorCallbacks/DefenseEditorTarget are re-exported so existing
// importers (`from './DefenseEditorScene'`) keep resolving to this file, not the directory.
//
// 2026-08-11: converted from the former `XMixin(Base)` inheritance chain to composition — see
// claudedocs/client-modules.md's split-form priority note. The render dispatcher lives here since
// only this assembly knows about every domain instance (Core takes a `render` callback instead of
// owning render() itself). The InputManager onDown/onMove/onUp/onWheel subscriptions live on Core
// instead (see DefenseEditorScene/core.ts's header comment) — onDown/onMove/onUp are wired there
// via lazy closures passed in below, since the InputPanel instance they delegate to doesn't exist
// until after Core is constructed.
import type { Scene } from './SceneManager';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { txt, tearDownChildren, ui as C } from '../render/sketchUi';
import { FS } from '../render/fontScale';
import { drawSceneHeader, HEADER_ACCENT } from '../ui/widgets/SceneHeader';
import { DefenseEditorSceneCore, FOOTER_H, PALETTE_H, PAD } from './DefenseEditorScene/core';
import type { DefenseEditorCallbacks } from './DefenseEditorScene/core';
import { DataPanel } from './DefenseEditorScene/data';
import { RenderPanel } from './DefenseEditorScene/render';
import { InputPanel } from './DefenseEditorScene/input';

export type { DefenseEditorCallbacks, DefenseEditorTarget } from './DefenseEditorScene/core';

/**
 * DefenseEditorScene — the SLG defense/attack-team editor scene registered against SceneManager,
 * thin assembly over the per-domain composition (see the file-header comment above).
 */
export class DefenseEditorScene implements Scene {
  readonly container;

  private readonly core: DefenseEditorSceneCore;
  private readonly data: DataPanel;
  private readonly renderPanel: RenderPanel;
  private readonly input: InputPanel;

  constructor(layout: ILayout, input: InputManager, cb: DefenseEditorCallbacks) {
    // handlers is a bundle of lazy closures: InputPanel doesn't exist yet (constructed after Core
    // below), but by the time InputManager actually fires one of these, this constructor has
    // finished and `this.input` is set — same lazy-binding trick as the `render` callback.
    this.core = new DefenseEditorSceneCore(layout, cb, () => this.render(), input, {
      onDown: (x, y) => this.input.handleDown(x, y),
      onMove: (x, y) => this.input.handleMove(x, y),
      onUp: (x, y) => this.input.handleUp(x, y),
    });
    this.container = this.core.container;
    this.data = new DataPanel(this.core);
    this.renderPanel = new RenderPanel(this.core, this.data);
    this.input = new InputPanel(this.core);

    this.render();
    void this.data.loadData();
  }

  update(dt: number): void {
    this.core.update(dt);
  }

  destroy(): void {
    this.core.destroy();
  }

  private render(): void {
    const core = this.core;
    tearDownChildren(core.bodyLayer);
    core.hits = [];
    core.rosterCardHits = [];
    const { w, h } = core;

    // Header: back + title + base-level stepper (drawn on the right slot below)
    const hdr = drawSceneHeader(core.bodyLayer, w, core.h, core.titleText(), {
      variant: 'paper',
      accent: HEADER_ACCENT.slg,
    });
    core.hits.push({ rect: hdr.backRect, action: () => core.cb.onBack() });

    // Base-level stepper (defense only — attacker has no base/buildings)
    if (core.hasBuildingRow) this.renderPanel.renderBaseStepper(w - PAD, 8);
    // Attack mode: the troop readout (top-left) + Fill/Clear/Save (top-right) live in the header's
    // free space instead of a bottom footer, so the whole footer band goes to the grid + roster
    // (2026-07-22, user request "move these two up top").
    if (core.mode === 'attack') this.renderPanel.renderAttackHeaderControls(hdr.headerH);

    // Attack mode has no bottom footer (controls moved into the header); defense keeps it.
    const footerH = core.mode === 'attack' ? 0 : FOOTER_H;
    const gridBottom = h - footerH - 4;
    if (core.mode === 'attack') {
      // Left half = formation grid, right half = scrollable card roster (布阵/选卡 split).
      this.renderPanel.renderAttackBody(hdr.headerH + 4, gridBottom);
    } else {
      this.renderPanel.renderPalette(hdr.headerH + 4);
      const gridTop = hdr.headerH + 4 + PALETTE_H + 4;
      this.renderPanel.renderGrid(gridTop, gridBottom);
    }

    // Footer: counts + clear + save (defense only)
    if (core.mode !== 'attack') this.renderPanel.renderFooter(h - FOOTER_H);

    if (core.loading) {
      const lbl = txt(t('world.loading'), FS.tiny, C.mid);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = w / 2;
      lbl.y = h / 2;
      core.bodyLayer.addChild(lbl);
    }
  }
}
