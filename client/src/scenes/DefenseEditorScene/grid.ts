// Formation grid rendering (units/buildings/base icon) for the defense editor — split out of
// render.ts (2026-08-11, form ① independent function module per claudedocs/client-modules.md's
// split-form priority note) purely to keep render.ts under the 500-line convention. Only ever
// called from RenderPanel's own methods (renderGrid/drawBuilding/drawUnit/drawArtFit, each now a
// one-line delegate) and from roster.ts's renderRosterCell (card portraits reuse the same
// drawArtFit), so these take `core` explicitly instead of becoming their own domain class.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { unitPortraitUrl, equippedSkinIdFor, getArtTexture } from '../../render/cardArt';
import { ATTACK_LANES, BASE_COLS, UNIT_BLUEPRINTS } from '@nw/engine/config';
import { fromFp } from '@nw/engine';
import baseTexUrl from '../../assets/buildings/game_base.png';
import { UnitType, BuildingType } from '@nw/engine/types';
import { PAD } from './core';
import type { DefenseEditorSceneCore } from './core';
// Self-import (2026-08-11): renderGrid's base-icon call below used to be `this.drawArtFit(...)`,
// a same-instance dynamic dispatch that vi.spyOn(instance, 'drawArtFit') could intercept freely.
// Now that drawArtFit is a free function, a bare in-module call to it is a lexical reference that
// vi.spyOn(gridModule, 'drawArtFit') from a test file can't patch (module-namespace mocking only
// rewrites cross-module references, not a module's own internal calls to its own exports — verified
// empirically, not a guess). Routing through this module's own namespace object makes the call go
// through the same mutable binding the test patches, at the cost of one unusual-looking indirection.
import * as gridSelf from './grid';

/** Draw a unit portrait fit into a box, centered; re-render once its texture loads (mirrors TeamsScene). */
export function drawArtFit(
  core: DefenseEditorSceneCore,
  url: string,
  x: number,
  y: number,
  boxW: number,
  boxH: number
): void {
  const tex = getArtTexture(url);
  if (!tex.baseTexture.valid) {
    if (!core.artHooked.has(url)) {
      core.artHooked.add(url);
      tex.baseTexture.once('loaded', () => {
        if (!core.destroyed) core.render();
      });
    }
    return;
  }
  const scale = Math.min(boxW / tex.width, boxH / tex.height);
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(0.5);
  sp.scale.set(scale);
  sp.position.set(x + boxW / 2, y + boxH / 2);
  core.bodyLayer.addChild(sp);
}

/** Pure geometry — no core state needed (a triangle for ArrowTower, a square for barracks). */
export function drawBuilding(
  g: PIXI.Graphics,
  px: number,
  py: number,
  cw: number,
  ch: number,
  type: BuildingType
): void {
  const cx = px + cw / 2,
    cy = py + ch / 2;
  const r = Math.min(cw, ch) * 0.32;
  if (type === BuildingType.ArrowTower) {
    g.lineStyle(1.5, 0x6a5a20, 1);
    g.beginFill(C.gold, 0.9);
    // triangle (tower)
    g.drawPolygon([cx, cy - r, cx + r, cy + r, cx - r, cy + r]);
    g.endFill();
  } else {
    g.lineStyle(1.5, 0x6a5a20, 1);
    g.beginFill(0xcc9900, 0.85);
    g.drawRect(cx - r, cy - r, r * 2, r * 2); // square (barracks)
    g.endFill();
  }
}

export function drawUnit(
  core: DefenseEditorSceneCore,
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
  const cx = px + cw / 2,
    cy = py + ch / 2;
  const size = Math.min(cw, ch) * 0.72;
  const bx = cx - size / 2,
    by = cy - size / 2;
  const artUrl = unitPortraitUrl(type, equippedSkinIdFor(type, core.cb.getSave?.()?.equipped));
  if (artUrl) {
    const frame = sketchPanel(size, size, {
      // The leader wears a gold frame so its portrait reads as "this is the team" even before the ★.
      fill: 0xf0eee7,
      border: isLeader ? C.gold : 0x33425a,
      width: isLeader ? 2.4 : 1.2,
      seed: seedFor(px, py, size),
    });
    frame.x = bx;
    frame.y = by;
    core.bodyLayer.addChild(frame);
    drawArtFit(core, artUrl, bx + 1, by + 1, size - 2, size - 2);
  } else {
    const r = size / 2;
    g.lineStyle(1.2, 0x33425a, 1);
    g.beginFill(0x4477cc, 0.92);
    g.drawCircle(cx, cy, r);
    g.endFill();
  }

  // Attack mode: a troop bar above the head showing currentTroops / troopCap(card), green→amber→red by
  // fill ratio, so at-a-glance you see how many soldiers each on-field character carries.
  //
  // Two-tone since 2026-08-19 (ADR-069): only the first `unitBattleHp` troops become the unit's HP in
  // battle (the engine clamps `hp = min(troops, blueprint.hp)`), while troops beyond that still buy
  // base damage (`siegeValue × troops / 60`) and nothing else. Those two roles used to be
  // indistinguishable in a single flat bar — a shieldbearer at 100/100 troops and an infantry at
  // 200/200 both read "full", though the infantry was throwing 70% of its soldiers at siege only. The
  // segment past the HP cap is drawn in a distinct colour so that split is visible where the player
  // actually allocates. Baseline blueprint HP (no card level / gear), same basis as `cardHp()` in the
  // roster detail panel — the exact in-battle cap includes those buffs.
  if (hp !== undefined && core.mode === 'attack' && cap && cap > 0) {
    const ratio = Math.max(0, Math.min(1, hp / cap));
    const barW = size,
      barH = 3,
      byBar = by - barH - 1;
    const barColor = ratio >= 0.66 ? 0x4caf50 : ratio >= 0.33 ? 0xe0a020 : 0xcc3b3b;
    g.beginFill(0x000000, 0.28);
    g.drawRect(bx, byBar, barW, barH);
    g.endFill();
    const unitBattleHp = fromFp(UNIT_BLUEPRINTS[type]?.hp_fp ?? 0);
    const hpRatio = Math.max(0, Math.min(ratio, unitBattleHp / cap));
    g.beginFill(barColor, 1);
    g.drawRect(bx, byBar, barW * hpRatio, barH);
    g.endFill();
    if (ratio > hpRatio) {
      // Siege-only surplus: violet, deliberately outside the green/amber/red "how full is it" scale so
      // it reads as a different KIND of troop rather than a fuller bar.
      g.beginFill(0x8a6cd4, 1);
      g.drawRect(bx + barW * hpRatio, byBar, barW * (ratio - hpRatio), barH);
      g.endFill();
    }
  }

  // ★ badge on the team's leader (the card whose portrait represents the team elsewhere).
  if (isLeader) {
    const star = txt('★', FS.small, C.gold, true);
    star.anchor.set(0.5, 0.5);
    star.x = bx + size - 2;
    star.y = by + 2;
    core.bodyLayer.addChild(star);
  }

  // Live troop count under the icon — a card's cardState ledger, not a blueprint-relative HP fraction
  // (a card's troop count isn't bounded by the unit's base HP stat).
  if (hp !== undefined && core.mode === 'attack') {
    const label = txt(String(hp), FS.micro, 0x222222, true);
    label.anchor.set(0.5, 0);
    label.x = cx;
    label.y = by + size + 1;
    core.bodyLayer.addChild(label);
  }
}

export function renderGrid(
  core: DefenseEditorSceneCore,
  top: number,
  bottom: number,
  areaX?: number,
  areaW?: number
): void {
  const ax = areaX ?? PAD;
  const aw = areaW ?? core.w - PAD * 2;
  const buildRows = core.hasBuildingRow ? 1 : 0;
  const rows = buildRows + core.gRows.length; // (defense: building row +) garrison rows
  const availW = aw;
  const availH = bottom - top;
  const cellW = availW / 12;
  const cellH = Math.min(cellW, availH / rows);
  const gridW = cellW * 12;
  const gridH = cellH * rows;
  const gridX = ax + (aw - gridW) / 2;
  const gridY = top + (availH - gridH) / 2;
  core.gridX = gridX;
  core.gridY = gridY;
  core.cellW = cellW;
  core.cellH = cellH;

  const g = new PIXI.Graphics();
  core.bodyLayer.addChild(g);

  const attackSet = new Set<number>(ATTACK_LANES as readonly number[]);
  const [baseLo, baseHi] = BASE_COLS;
  const leaderId = core.effectiveLeaderId();

  // Display rows: (defense only) dr 0 = building row; remaining = this.gRows
  for (let dr = 0; dr < rows; dr++) {
    const isBuildingRow = core.hasBuildingRow && dr === 0;
    const py = gridY + dr * cellH;
    for (let col = 0; col < 12; col++) {
      const px = gridX + col * cellW;
      const isBaseCol = col >= baseLo && col <= baseHi;
      const isAttack = attackSet.has(col);

      // Cell background
      let fill = 0xf2ece0;
      if (isBaseCol) fill = isBuildingRow ? 0xd9b3b3 : 0xe6dccb; // base column tint
      g.beginFill(fill, 0.85);
      g.lineStyle(0.6, 0xc8bba8, 0.7);
      g.drawRect(px + 0.5, py + 0.5, cellW - 1, cellH - 1);
      g.endFill();

      // Content
      if (isBuildingRow) {
        if (isBaseCol && col === baseLo) {
          g.beginFill(0xcc3333, 0.5);
          g.drawRect(px + 2, py + 2, cellW * 2 - 4, cellH - 4);
          g.endFill();
        }
        if (isAttack) {
          const b = core.buildings.get(col);
          if (b) drawBuilding(g, px, py, cellW, cellH, b);
        }
      } else {
        const row = core.gRows[dr - buildRows]!;
        if (isAttack) {
          const key = `${col}:${row}`;
          const u = core.garrison.get(key);
          if (u) {
            const cap =
              core.mode === 'attack' && u.cardInstanceId
                ? core.capForCard(u.cardInstanceId)
                : undefined;
            drawUnit(
              core,
              g,
              px,
              py,
              cellW,
              cellH,
              u.unitType,
              u.hp,
              cap,
              !!u.cardInstanceId && u.cardInstanceId === leaderId
            );
          }
        } else if (!core.hasBuildingRow && dr === rows - 1 && isBaseCol && col === baseLo) {
          // Attack mode only: the home base sits just past this row (row 0 is off-grid), so the
          // same castle art PvP battles use is drawn into the base-column band at the near edge —
          // reads as "this is your base" without a text label (2026-08-02: the old "出兵" label
          // went unnoticed, replaced with this icon instead of kept alongside it).
          gridSelf.drawArtFit(core, baseTexUrl as string, px, py, cellW * 2, cellH);
        }
      }
    }
  }

  // Row label (left): defense mode only — attack mode drops the label for the base icon above.
  if (core.hasBuildingRow) {
    const lbl = txt(t('world.defense.buildRow'), FS.micro, C.mid);
    lbl.anchor.set(1, 0.5);
    lbl.x = gridX - 3;
    lbl.y = gridY + cellH / 2;
    core.bodyLayer.addChild(lbl);
  }
}
