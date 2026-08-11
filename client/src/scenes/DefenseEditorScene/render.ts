// Chrome rendering for the defense editor: base-level stepper, palette, footer, and the header/
// footer action button clusters. The formation grid (grid.ts) and the attack-mode card roster
// (roster.ts) are split into their own form-① free-function modules — see each file's header
// comment — since RenderPanel just needs a one-line delegate for each, not their full bodies here.
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import * as PIXI from 'pixi.js-legacy';
import { BuildingType, UnitType } from '@nw/engine/types';
import type { CardInstance } from '../../game/meta/SaveData';
import {
  COLLECTED_UNITS,
  COLLECTED_BUILDINGS,
  nameKeyFor,
  PALETTE_H,
  FOOTER_H,
  PAD,
  MAX_BASE_LEVEL,
} from './core';
import type { DefenseEditorSceneCore, Tool } from './core';
import {
  renderGrid as renderGridImpl,
  drawBuilding as drawBuildingImpl,
  drawUnit as drawUnitImpl,
  drawArtFit as drawArtFitImpl,
} from './grid';
import {
  renderAttackBody as renderAttackBodyImpl,
  renderAttackToolbar as renderAttackToolbarImpl,
  renderCardRosterPanel as renderCardRosterPanelImpl,
  renderRosterCell as renderRosterCellImpl,
} from './roster';

export interface RenderHandlers {
  renderBaseStepper(rightX: number, y: number): void;
  renderPalette(top: number): void;
  renderAttackBody(top: number, bottom: number): void;
  renderAttackToolbar(x: number, y: number, w: number, h: number): void;
  renderCardRosterPanel(x: number, y: number, w: number, h: number): void;
  renderRosterCell(
    c: { card: CardInstance; unitType: UnitType; troops: number; cap: number },
    x: number,
    y: number,
    cellW: number,
    cellH: number
  ): void;
  drawArtFit(url: string, x: number, y: number, boxW: number, boxH: number): void;
  renderGrid(top: number, bottom: number, areaX?: number, areaW?: number): void;
  drawBuilding(
    g: PIXI.Graphics,
    px: number,
    py: number,
    cw: number,
    ch: number,
    type: BuildingType
  ): void;
  drawUnit(
    g: PIXI.Graphics,
    px: number,
    py: number,
    cw: number,
    ch: number,
    type: UnitType,
    hp?: number,
    cap?: number,
    isLeader?: boolean
  ): void;
  renderFooter(top: number): void;
  renderAttackHeaderControls(headerH: number): void;
  renderActionButtons(rightEdge: number, top: number, rowH: number, scale?: number): void;
}

/** The two DataPanel methods RenderPanel's action buttons need — narrowed per
 *  claudedocs/client-modules.md's composition rule (constructor takes the smallest interface that
 *  covers the actual cross-domain calls, not the whole sibling class). */
export interface SaveActions {
  doSave(): Promise<void>;
  doFillTroops(): Promise<void>;
}

/** Rendering domain (see ../DefenseEditorScene.ts assembly + ./core.ts for the shared state). */
export class RenderPanel implements RenderHandlers {
  constructor(
    private readonly core: DefenseEditorSceneCore,
    private readonly saveActions: SaveActions
  ) {}

  // ── Formation grid + attack-mode card roster: one-line delegates to grid.ts/roster.ts ──────
  renderGrid(top: number, bottom: number, areaX?: number, areaW?: number): void {
    renderGridImpl(this.core, top, bottom, areaX, areaW);
  }

  drawBuilding(
    g: PIXI.Graphics,
    px: number,
    py: number,
    cw: number,
    ch: number,
    type: BuildingType
  ): void {
    drawBuildingImpl(g, px, py, cw, ch, type);
  }

  drawUnit(
    g: PIXI.Graphics,
    px: number,
    py: number,
    cw: number,
    ch: number,
    type: UnitType,
    hp?: number,
    cap?: number,
    isLeader = false
  ): void {
    drawUnitImpl(this.core, g, px, py, cw, ch, type, hp, cap, isLeader);
  }

  drawArtFit(url: string, x: number, y: number, boxW: number, boxH: number): void {
    drawArtFitImpl(this.core, url, x, y, boxW, boxH);
  }

  renderAttackBody(top: number, bottom: number): void {
    renderAttackBodyImpl(this.core, top, bottom);
  }

  renderAttackToolbar(x: number, y: number, w: number, h: number): void {
    renderAttackToolbarImpl(this.core, x, y, w, h);
  }

  renderCardRosterPanel(x: number, y: number, w: number, h: number): void {
    renderCardRosterPanelImpl(this.core, x, y, w, h);
  }

  renderRosterCell(
    c: { card: CardInstance; unitType: UnitType; troops: number; cap: number },
    x: number,
    y: number,
    cellW: number,
    cellH: number
  ): void {
    renderRosterCellImpl(this.core, c, x, y, cellW, cellH);
  }

  // ── Chrome: base stepper / palette / footer / header controls / action buttons ──────────────

  renderBaseStepper(rightX: number, y: number): void {
    const core = this.core;
    const btnW = 24,
      btnH = 24;
    const lbl = txt(
      t('world.defense.baseLevel').replace('{lv}', String(core.baseLevel)),
      FS.micro,
      C.dark
    );
    // [-] label [+] laid right-aligned
    const plus = sketchPanel(btnW, btnH, {
      fill: C.dark,
      border: C.gold,
      seed: seedFor(rightX, y, btnW),
    });
    plus.x = rightX - btnW;
    plus.y = y;
    core.bodyLayer.addChild(plus);
    const plusLbl = txt('+', FS.small, C.light);
    plusLbl.anchor.set(0.5, 0.5);
    plusLbl.x = plus.x + btnW / 2;
    plusLbl.y = plus.y + btnH / 2;
    core.bodyLayer.addChild(plusLbl);
    core.hits.push({
      rect: { x: plus.x, y: plus.y, w: btnW, h: btnH },
      action: () => {
        core.baseLevel = Math.min(MAX_BASE_LEVEL, core.baseLevel + 1);
        core.render();
      },
    });

    lbl.anchor.set(1, 0.5);
    lbl.x = plus.x - 6;
    lbl.y = y + btnH / 2;
    core.bodyLayer.addChild(lbl);

    const minus = sketchPanel(btnW, btnH, {
      fill: C.dark,
      border: C.gold,
      seed: seedFor(rightX, y + 1, btnW),
    });
    minus.x = lbl.x - lbl.width - 6 - btnW;
    minus.y = y;
    core.bodyLayer.addChild(minus);
    const minusLbl = txt('−', FS.small, C.light);
    minusLbl.anchor.set(0.5, 0.5);
    minusLbl.x = minus.x + btnW / 2;
    minusLbl.y = minus.y + btnH / 2;
    core.bodyLayer.addChild(minusLbl);
    core.hits.push({
      rect: { x: minus.x, y: minus.y, w: btnW, h: btnH },
      action: () => {
        core.baseLevel = Math.max(0, core.baseLevel - 1);
        core.render();
      },
    });
  }

  renderPalette(top: number): void {
    const core = this.core;
    const { w } = core;
    const tools: { tool: Tool; label: string; tint: number }[] = [
      // Buildings are defense-mode only (attacker places units only).
      ...(core.hasBuildingRow
        ? COLLECTED_BUILDINGS.map((bt) => ({
            tool: { kind: 'building', type: bt } as Tool,
            label: t(nameKeyFor('building', bt)),
            tint: C.gold,
          }))
        : []),
      ...COLLECTED_UNITS.map((ut) => ({
        tool: { kind: 'unit', type: ut } as Tool,
        label: t(nameKeyFor('unit', ut)),
        tint: C.accent,
      })),
      { tool: { kind: 'erase' } as Tool, label: t('world.defense.erase'), tint: C.red },
    ];
    const n = tools.length;
    const gap = 5;
    const btnW = (w - PAD * 2 - gap * (n - 1)) / n;
    const btnH = PALETTE_H - 10;
    let x = PAD;
    for (const { tool, label, tint } of tools) {
      const active = core.toolEquals(tool, core.tool);
      const box = sketchPanel(btnW, btnH, {
        fill: active ? tint : C.paper,
        border: active ? C.dark : tint,
        width: active ? 2.4 : 1.4,
        seed: seedFor(x, top, btnW),
      });
      box.x = x;
      box.y = top + 5;
      core.bodyLayer.addChild(box);
      const lbl = txt(label, FS.micro, active ? C.light : C.dark, true);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = x + btnW / 2;
      lbl.y = top + 5 + btnH / 2;
      core.bodyLayer.addChild(lbl);
      const captured = tool;
      core.hits.push({
        rect: { x, y: top + 5, w: btnW, h: btnH },
        action: () => {
          core.tool = captured;
          core.render();
        },
      });
      x += btnW + gap;
    }
  }

  /** Defense footer: counts + hint on the left, action buttons on the right. (Attack mode has no footer.) */
  renderFooter(top: number): void {
    const core = this.core;
    const { w } = core;
    const panel = sketchPanel(w, FOOTER_H, {
      fill: C.paper,
      border: C.mid,
      seed: seedFor(0, top, w),
    });
    panel.y = top;
    core.bodyLayer.addChild(panel);

    const countsStr = `${t('world.defense.buildings')} ${core.buildings.size}   ${t(
      'world.defense.garrison'
    ).replace('{n}', String(core.garrison.size))}`;
    const counts = txt(countsStr, FS.micro, C.dark);
    counts.x = PAD;
    counts.y = top + 8;
    core.bodyLayer.addChild(counts);

    const hint = txt(t('world.defense.hint'), FS.micro, C.mid);
    hint.x = PAD;
    hint.y = top + 26;
    core.bodyLayer.addChild(hint);

    this.renderActionButtons(w - PAD, top, FOOTER_H);
  }

  /**
   * Attack-mode header controls: the troop readout (garrison / committed / pool) at the top-left
   * (right of the back pill, scaled to clear the centred title) + the Fill/Clear/Save cluster at the
   * top-right — both drawn over the baked header chrome so the bottom footer band frees up entirely.
   */
  renderAttackHeaderControls(headerH: number): void {
    const core = this.core;
    const { w } = core;
    const troopsStr = `${core.committedTroops()}/${core.teamCapacity()}`;
    // "Garrison N" used to head this readout, but in attack mode N is the number of hero cards placed,
    // not a garrison size — it sat next to the troop count and read as if the two measured the same thing.
    const countsStr = `${t('world.team.cards').replace('{n}', String(core.garrison.size))}   ${t(
      'world.team.committed'
    ).replace('{n}', troopsStr)}   ${t('world.team.pool').replace('{n}', String(core.troops))}`;
    // ~2x the old FS.small readout — approved 2026-07-23 (user: PC screen, top-bar text too small).
    const counts = txt(countsStr, FS.title, C.dark, true);
    counts.anchor.set(0, 0.5);
    const startX = 210; // clears the back pill (constant width in the shared 1080 design space)
    counts.x = startX;
    counts.y = headerH / 2;
    // Keep clear of the horizontally-centred title (measure it to find its left edge).
    const titleNode = txt(core.titleText(), FS.headline, C.dark, true);
    const titleLeft = w / 2 - titleNode.width / 2;
    titleNode.destroy({ texture: true, baseTexture: true });
    const avail = titleLeft - 12 - startX;
    if (avail > 20 && counts.width > avail) counts.scale.set(avail / counts.width);
    core.bodyLayer.addChild(counts);

    // ~2x the shared button size, only in the roomy attack header (the defense footer keeps scale 1).
    this.renderActionButtons(w - PAD, 0, headerH, 2);
  }

  /**
   * Right-aligned Fill troops (attack only) / Clear / Save cluster, vertically centred on the band
   * [top, top+rowH] ending at `rightEdge`. Shared by the defense footer (scale 1) and the attack header
   * (scale 2 — the header band is tall enough and the PC readout needs to be legible).
   */
  renderActionButtons(rightEdge: number, top: number, rowH: number, scale = 1): void {
    const core = this.core;
    const btnW = 70 * scale,
      btnH = 30 * scale,
      gap = 8 * scale;
    const labelSize = scale >= 2 ? FS.heading : FS.tiny;
    const cy = top + (rowH - btnH) / 2;
    const save = sketchPanel(btnW, btnH, {
      fill: C.dark,
      border: C.gold,
      seed: seedFor(rightEdge, top, btnW),
    });
    save.x = rightEdge - btnW;
    save.y = cy;
    core.bodyLayer.addChild(save);
    const saveLbl = txt(t('world.defense.save'), labelSize, C.light, true);
    saveLbl.anchor.set(0.5, 0.5);
    saveLbl.x = save.x + btnW / 2;
    saveLbl.y = save.y + btnH / 2;
    core.bodyLayer.addChild(saveLbl);
    core.hits.push({
      rect: { x: save.x, y: save.y, w: btnW, h: btnH },
      action: () => void this.saveActions.doSave(),
    });

    const clear = sketchPanel(btnW, btnH, {
      fill: C.paper,
      border: C.red,
      seed: seedFor(rightEdge, top + 1, btnW),
    });
    clear.x = save.x - btnW - gap;
    clear.y = cy;
    core.bodyLayer.addChild(clear);

    if (core.mode === 'attack') {
      const fillFull = core.teamCapacity() > 0 && core.committedTroops() >= core.teamCapacity();
      const fillW = 84 * scale;
      const fill = sketchPanel(fillW, btnH, {
        fill: C.paper,
        border: fillFull ? C.mid : C.gold,
        seed: seedFor(rightEdge, top + 2, fillW),
      });
      fill.x = clear.x - fillW - gap;
      fill.y = cy;
      core.bodyLayer.addChild(fill);
      const fillLbl = txt(t('world.team.fill'), labelSize, fillFull ? C.mid : C.dark, true);
      fillLbl.anchor.set(0.5, 0.5);
      fillLbl.x = fill.x + fillW / 2;
      fillLbl.y = fill.y + btnH / 2;
      if (fillLbl.width > fillW - 6) fillLbl.scale.set((fillW - 6) / fillLbl.width);
      core.bodyLayer.addChild(fillLbl);
      if (!fillFull) {
        core.hits.push({
          rect: { x: fill.x, y: fill.y, w: fillW, h: btnH },
          action: () => void this.saveActions.doFillTroops(),
        });
      }
    }
    const clearLbl = txt(t('world.defense.clear'), labelSize, C.red, true);
    clearLbl.anchor.set(0.5, 0.5);
    clearLbl.x = clear.x + btnW / 2;
    clearLbl.y = clear.y + btnH / 2;
    core.bodyLayer.addChild(clearLbl);
    core.hits.push({
      rect: { x: clear.x, y: clear.y, w: btnW, h: btnH },
      action: () => {
        core.buildings.clear();
        core.garrison.clear();
        core.baseLevel = 0;
        core.leaderCardId = null;
        core.render();
      },
    });
  }
}
