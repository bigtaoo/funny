// DefenseEditorScene — SLG 简化摆位防守编辑器（S8-9 C3）
//
// 玩家为主城（tileKey='base'）或某块己方领地（tileKey='{x}:{y}'）编辑一份防守 config，
// 形态 = 引擎 LevelDefinition 的受限子集（U8 / U10）：
//   - garrison           驻军：在防守方（Top）半场预置已收集单位（步兵/盾兵/弓手）
//   - defenderBuildings  防守建筑：在建筑行（TOP_BUILDING_ROW）放箭塔/兵营
//   - defenderBaseLevel  基地强化：0–3 级
// 围攻发生时 worldsvc / 客户端用 buildSiegeLevel(config) 把它规整成可打的围攻关卡。
//
// 「已收集单位」约束（U8）：调色板只列出有卡牌（CARD_DEFINITIONS）的单位/建筑类型，
// PvE-only 单位（Ironclad/Runner/…，无卡）天然不出现，玩家无法摆放未收集内容。
//
// 交互：选调色板工具（单位/建筑/擦除）→ 点格子摆放/替换/移除；基地强化用上下步进。
// 预填：进入时拉 getDefense 还原上次配置。保存走 setDefense（覆盖写）。

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { Scene } from './SceneManager';
import { t, type TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor } from '../render/sketchUi';
import type { WorldApiClient } from '../net/WorldApiClient';
import { WorldApiError } from '../net/WorldApiClient';
import { ATTACK_LANES, BASE_COLS, CARD_DEFINITIONS } from '../game/config';
import { CardType, UnitType, BuildingType } from '../game/types';

export interface DefenseEditorCallbacks {
  onBack(): void;
  worldApi: WorldApiClient;
  worldId: string;
  /** 'base' 主城 或 '{x}:{y}' 己方领地键。 */
  tileKey: string;
}

// ── Collected pool (U8) ───────────────────────────────────────────────────────
// 仅来自卡牌定义的单位/建筑类型 = 玩家可摆放的「已收集」集合；保留卡表出现顺序。

function distinctCollected<T extends string>(pick: (c: typeof CARD_DEFINITIONS[number]) => T | undefined): T[] {
  const out: T[] = [];
  for (const card of CARD_DEFINITIONS) {
    const v = pick(card);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

const COLLECTED_UNITS = distinctCollected((c) =>
  c.cardType === CardType.Unit ? (c.unitType as UnitType | undefined) : undefined);
const COLLECTED_BUILDINGS = distinctCollected((c) =>
  c.cardType === CardType.Building ? (c.buildingType as BuildingType | undefined) : undefined);

/** First card display-name key for a given unit/building type (label reuse, no new keys). */
function nameKeyFor(kind: 'unit' | 'building', type: string): TranslationKey {
  for (const card of CARD_DEFINITIONS) {
    if (kind === 'unit' && card.unitType === type) return card.nameKey;
    if (kind === 'building' && card.buildingType === type) return card.nameKey;
  }
  return 'world.defense.title';
}

// ── Tools ──────────────────────────────────────────────────────────────────────

type Tool =
  | { kind: 'unit'; type: UnitType }
  | { kind: 'building'; type: BuildingType }
  | { kind: 'erase' };

// Defender deployment zone shown top→bottom: building row first, then garrison rows
// 16..9 (defender's own half). Garrison schema allows rows 1..16; we expose the back
// half which is where a defender realistically forts up — keeps the grid mobile-sized.
const GARRISON_ROWS = [16, 15, 14, 13, 12, 11, 10, 9] as const;

const MAX_GARRISON = 30;

// ── Caps / layout ────────────────────────────────────────────────────────────

const HEADER_H = 46;
const PALETTE_H = 54;
const FOOTER_H = 58;
const PAD = 10;

// ── Scene ───────────────────────────────────────────────────────────────────────

export class DefenseEditorScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: DefenseEditorCallbacks;

  // Config state
  private buildings = new Map<number, BuildingType>();        // col → building (building row)
  private garrison = new Map<string, UnitType>();             // "col:row" → unit
  private baseLevel = 0;

  private tool: Tool = { kind: 'erase' };
  private loading = true;
  private saving = false;
  private destroyed = false;

  // Layers
  private bodyLayer!: PIXI.Container;
  private toastLayer!: PIXI.Container;

  // Hit rects (rebuilt each render)
  private hits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];

  // Grid geometry (computed in render)
  private gridX = 0;
  private gridY = 0;
  private cellW = 0;
  private cellH = 0;

  private toastTimer = 0;
  private readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: DefenseEditorCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.container = new PIXI.Container();

    const bg = buildPaperBackground('defense', this.w, this.h);
    this.container.addChild(bg);
    this.bodyLayer = new PIXI.Container();
    this.container.addChild(this.bodyLayer);
    this.toastLayer = new PIXI.Container();
    this.container.addChild(this.toastLayer);

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));

    this.render();
    void this.loadData();
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  private async loadData(): Promise<void> {
    try {
      const cfg = await this.cb.worldApi.getDefense(this.cb.worldId, this.cb.tileKey);
      if (cfg && !this.destroyed) this.applyConfig(cfg as Record<string, unknown>);
    } catch { /* offline / unset — start blank */ }
    this.loading = false;
    if (!this.destroyed) this.render();
  }

  /** Decode a stored DefenseConfig subset back into editor state (tolerant of junk). */
  private applyConfig(cfg: Record<string, unknown>): void {
    this.buildings.clear();
    this.garrison.clear();
    const g = cfg.garrison;
    if (Array.isArray(g)) {
      for (const e of g) {
        if (!e || typeof e !== 'object') continue;
        const { unitType, col, row } = e as Record<string, unknown>;
        if (typeof unitType === 'string' && (COLLECTED_UNITS as string[]).includes(unitType)
          && typeof col === 'number' && (ATTACK_LANES as readonly number[]).includes(col)
          && typeof row === 'number' && (GARRISON_ROWS as readonly number[]).includes(row)) {
          this.garrison.set(`${col}:${row}`, unitType as UnitType);
        }
      }
    }
    const b = cfg.defenderBuildings;
    if (Array.isArray(b)) {
      for (const e of b) {
        if (!e || typeof e !== 'object') continue;
        const { buildingType, col } = e as Record<string, unknown>;
        if (typeof buildingType === 'string' && (COLLECTED_BUILDINGS as string[]).includes(buildingType)
          && typeof col === 'number' && (ATTACK_LANES as readonly number[]).includes(col)) {
          this.buildings.set(col, buildingType as BuildingType);
        }
      }
    }
    const lv = cfg.defenderBaseLevel;
    this.baseLevel = typeof lv === 'number' ? Math.max(0, Math.min(3, Math.floor(lv))) : 0;
  }

  private async doSave(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    const config = {
      garrison: [...this.garrison.entries()].map(([key, unitType]) => {
        const [col, row] = key.split(':').map(Number);
        return { unitType, col, row };
      }),
      defenderBuildings: [...this.buildings.entries()].map(([col, buildingType]) => ({ buildingType, col })),
      defenderBaseLevel: this.baseLevel,
    };
    try {
      await this.cb.worldApi.setDefense(this.cb.worldId, this.cb.tileKey, config);
      this.showToast(t('world.defense.saved'));
      this.saving = false;
      this.cb.onBack();
    } catch (e) {
      this.saving = false;
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private errorMsg(e: unknown): string {
    if (e instanceof WorldApiError) {
      if (e.code === 'TILE_NOT_OWNED') return t('world.err.notOwner');
      return e.message;
    }
    return t('world.defense.saveFail');
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  private render(): void {
    this.bodyLayer.removeChildren();
    this.hits = [];
    const { w, h } = this;

    // Header: back + title + base-level stepper
    const header = sketchPanel(w, HEADER_H, { fill: C.paper, border: C.mid, seed: seedFor(0, 0, w) });
    this.bodyLayer.addChild(header);

    const back = txt(t('world.back'), 13, C.accent);
    back.x = PAD; back.y = (HEADER_H - back.height) / 2;
    this.bodyLayer.addChild(back);
    this.hits.push({ rect: { x: 0, y: 0, w: 90, h: HEADER_H }, action: () => this.cb.onBack() });

    const isBase = this.cb.tileKey === 'base';
    const titleStr = isBase
      ? t('world.defense.titleBase')
      : t('world.defense.titleTile').replace('{tile}', this.cb.tileKey);
    const title = txt(titleStr, 14, C.dark, true);
    title.anchor.set(0.5, 0);
    title.x = w / 2; title.y = (HEADER_H - title.height) / 2;
    this.bodyLayer.addChild(title);

    // Base-level stepper (right side of header)
    this.renderBaseStepper(w - PAD, 8);

    // Palette
    this.renderPalette(HEADER_H + 4);

    // Board grid
    const gridTop = HEADER_H + 4 + PALETTE_H + 4;
    const gridBottom = h - FOOTER_H - 4;
    this.renderGrid(gridTop, gridBottom);

    // Footer: counts + clear + save
    this.renderFooter(h - FOOTER_H);

    if (this.loading) {
      const lbl = txt(t('world.loading'), 13, C.mid);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = w / 2; lbl.y = h / 2;
      this.bodyLayer.addChild(lbl);
    }
  }

  private renderBaseStepper(rightX: number, y: number): void {
    const btnW = 24, btnH = 24;
    const lbl = txt(t('world.defense.baseLevel').replace('{lv}', String(this.baseLevel)), 11, C.dark);
    // [-] label [+] laid right-aligned
    const plus = sketchPanel(btnW, btnH, { fill: C.dark, border: C.gold, seed: seedFor(rightX, y, btnW) });
    plus.x = rightX - btnW; plus.y = y;
    this.bodyLayer.addChild(plus);
    const plusLbl = txt('+', 16, C.light); plusLbl.anchor.set(0.5, 0.5);
    plusLbl.x = plus.x + btnW / 2; plusLbl.y = plus.y + btnH / 2;
    this.bodyLayer.addChild(plusLbl);
    this.hits.push({ rect: { x: plus.x, y: plus.y, w: btnW, h: btnH }, action: () => {
      this.baseLevel = Math.min(3, this.baseLevel + 1); this.render();
    } });

    lbl.anchor.set(1, 0.5);
    lbl.x = plus.x - 6; lbl.y = y + btnH / 2;
    this.bodyLayer.addChild(lbl);

    const minus = sketchPanel(btnW, btnH, { fill: C.dark, border: C.gold, seed: seedFor(rightX, y + 1, btnW) });
    minus.x = lbl.x - lbl.width - 6 - btnW; minus.y = y;
    this.bodyLayer.addChild(minus);
    const minusLbl = txt('−', 16, C.light); minusLbl.anchor.set(0.5, 0.5);
    minusLbl.x = minus.x + btnW / 2; minusLbl.y = minus.y + btnH / 2;
    this.bodyLayer.addChild(minusLbl);
    this.hits.push({ rect: { x: minus.x, y: minus.y, w: btnW, h: btnH }, action: () => {
      this.baseLevel = Math.max(0, this.baseLevel - 1); this.render();
    } });
  }

  private renderPalette(top: number): void {
    const { w } = this;
    const tools: { tool: Tool; label: string; tint: number }[] = [
      ...COLLECTED_BUILDINGS.map((bt) => ({
        tool: { kind: 'building', type: bt } as Tool, label: t(nameKeyFor('building', bt)), tint: C.gold,
      })),
      ...COLLECTED_UNITS.map((ut) => ({
        tool: { kind: 'unit', type: ut } as Tool, label: t(nameKeyFor('unit', ut)), tint: C.accent,
      })),
      { tool: { kind: 'erase' } as Tool, label: t('world.defense.erase'), tint: C.red },
    ];
    const n = tools.length;
    const gap = 5;
    const btnW = (w - PAD * 2 - gap * (n - 1)) / n;
    const btnH = PALETTE_H - 10;
    let x = PAD;
    for (const { tool, label, tint } of tools) {
      const active = this.toolEquals(tool, this.tool);
      const box = sketchPanel(btnW, btnH, {
        fill: active ? tint : C.paper, border: active ? C.dark : tint,
        width: active ? 2.4 : 1.4, seed: seedFor(x, top, btnW),
      });
      box.x = x; box.y = top + 5;
      this.bodyLayer.addChild(box);
      const lbl = txt(label, 10, active ? C.light : C.dark, true);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = x + btnW / 2; lbl.y = top + 5 + btnH / 2;
      this.bodyLayer.addChild(lbl);
      const captured = tool;
      this.hits.push({ rect: { x, y: top + 5, w: btnW, h: btnH }, action: () => {
        this.tool = captured; this.render();
      } });
      x += btnW + gap;
    }
  }

  private toolEquals(a: Tool, b: Tool): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'erase' || b.kind === 'erase') return a.kind === b.kind;
    return (a as { type: string }).type === (b as { type: string }).type;
  }

  private renderGrid(top: number, bottom: number): void {
    const { w } = this;
    const rows = 1 + GARRISON_ROWS.length; // building row + garrison rows
    const availW = w - PAD * 2;
    const availH = bottom - top;
    const cellW = availW / 12;
    const cellH = Math.min(cellW, availH / rows);
    const gridW = cellW * 12;
    const gridH = cellH * rows;
    const gridX = (w - gridW) / 2;
    const gridY = top + (availH - gridH) / 2;
    this.gridX = gridX; this.gridY = gridY; this.cellW = cellW; this.cellH = cellH;

    const g = new PIXI.Graphics();
    this.bodyLayer.addChild(g);

    const attackSet = new Set<number>(ATTACK_LANES as readonly number[]);
    const [baseLo, baseHi] = BASE_COLS;

    // Display rows: 0 = building row (TOP_BUILDING_ROW), 1..n = GARRISON_ROWS
    for (let dr = 0; dr < rows; dr++) {
      const isBuildingRow = dr === 0;
      const py = gridY + dr * cellH;
      for (let col = 0; col < 12; col++) {
        const px = gridX + col * cellW;
        const isBaseCol = col >= baseLo && col <= baseHi;
        const isAttack = attackSet.has(col);

        // Cell background
        let fill = 0xf2ece0;
        if (isBaseCol) fill = isBuildingRow ? 0xd9b3b3 : 0xe6dccb; // defender base column tint
        g.beginFill(fill, 0.85);
        g.lineStyle(0.6, 0xc8bba8, 0.7);
        g.drawRect(px + 0.5, py + 0.5, cellW - 1, cellH - 1);
        g.endFill();

        // Content
        if (isBuildingRow) {
          if (isBaseCol && col === baseLo) {
            // Defender base marker spanning the two base cols
            g.beginFill(0xcc3333, 0.5);
            g.drawRect(px + 2, py + 2, cellW * 2 - 4, cellH - 4);
            g.endFill();
          }
          if (isAttack) {
            const b = this.buildings.get(col);
            if (b) this.drawBuilding(g, px, py, cellW, cellH, b);
          }
        } else {
          const row = GARRISON_ROWS[dr - 1]!;
          if (isAttack) {
            const u = this.garrison.get(`${col}:${row}`);
            if (u) this.drawUnit(g, px, py, cellW, cellH, u);
          }
        }
      }
    }

    // Row labels (left): build / 16..9
    const buildLbl = txt(t('world.defense.buildRow'), 9, C.mid);
    buildLbl.anchor.set(1, 0.5);
    buildLbl.x = gridX - 3; buildLbl.y = gridY + cellH / 2;
    this.bodyLayer.addChild(buildLbl);
  }

  private drawBuilding(g: PIXI.Graphics, px: number, py: number, cw: number, ch: number, type: BuildingType): void {
    const cx = px + cw / 2, cy = py + ch / 2;
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

  private drawUnit(g: PIXI.Graphics, px: number, py: number, cw: number, ch: number, type: UnitType): void {
    const cx = px + cw / 2, cy = py + ch / 2;
    const r = Math.min(cw, ch) * 0.3;
    const col = type === UnitType.Archer ? 0x44aa66
      : type === UnitType.ShieldBearer ? 0x8866cc
      : 0x4477cc;
    g.lineStyle(1.2, 0x33425a, 1);
    g.beginFill(col, 0.92);
    g.drawCircle(cx, cy, r);
    g.endFill();
  }

  private renderFooter(top: number): void {
    const { w } = this;
    const panel = sketchPanel(w, FOOTER_H, { fill: C.paper, border: C.mid, seed: seedFor(0, top, w) });
    panel.y = top;
    this.bodyLayer.addChild(panel);

    const counts = txt(
      `${t('world.defense.buildings')} ${this.buildings.size}   ${t('world.defense.garrison').replace('{n}', String(this.garrison.size))}`,
      11, C.dark,
    );
    counts.x = PAD; counts.y = top + 8;
    this.bodyLayer.addChild(counts);

    const hint = txt(t('world.defense.hint'), 9, C.mid);
    hint.x = PAD; hint.y = top + 26;
    this.bodyLayer.addChild(hint);

    // Clear + Save (right)
    const btnW = 70, btnH = 30;
    const save = sketchPanel(btnW, btnH, { fill: C.dark, border: C.gold, seed: seedFor(w, top, btnW) });
    save.x = w - btnW - PAD; save.y = top + (FOOTER_H - btnH) / 2;
    this.bodyLayer.addChild(save);
    const saveLbl = txt(t('world.defense.save'), 13, C.light, true);
    saveLbl.anchor.set(0.5, 0.5);
    saveLbl.x = save.x + btnW / 2; saveLbl.y = save.y + btnH / 2;
    this.bodyLayer.addChild(saveLbl);
    this.hits.push({ rect: { x: save.x, y: save.y, w: btnW, h: btnH }, action: () => void this.doSave() });

    const clear = sketchPanel(btnW, btnH, { fill: C.paper, border: C.red, seed: seedFor(w, top + 1, btnW) });
    clear.x = save.x - btnW - 8; clear.y = save.y;
    this.bodyLayer.addChild(clear);
    const clearLbl = txt(t('world.defense.clear'), 13, C.red, true);
    clearLbl.anchor.set(0.5, 0.5);
    clearLbl.x = clear.x + btnW / 2; clearLbl.y = clear.y + btnH / 2;
    this.bodyLayer.addChild(clearLbl);
    this.hits.push({ rect: { x: clear.x, y: clear.y, w: btnW, h: btnH }, action: () => {
      this.buildings.clear(); this.garrison.clear(); this.baseLevel = 0; this.render();
    } });
  }

  // ── Cell placement ───────────────────────────────────────────────────────────

  private onGridTap(sx: number, sy: number): void {
    if (this.cellW <= 0) return;
    const col = Math.floor((sx - this.gridX) / this.cellW);
    const dr = Math.floor((sy - this.gridY) / this.cellH);
    const rows = 1 + GARRISON_ROWS.length;
    if (col < 0 || col > 11 || dr < 0 || dr >= rows) return;
    if (!(ATTACK_LANES as readonly number[]).includes(col)) {
      this.showToast(t('world.defense.baseColBlocked'), C.red);
      return;
    }

    if (dr === 0) {
      // Building row
      if (this.tool.kind === 'erase') {
        this.buildings.delete(col);
      } else if (this.tool.kind === 'building') {
        this.buildings.set(col, this.tool.type);
      } else {
        this.showToast(t('world.defense.unitsNotHere'), C.red);
        return;
      }
    } else {
      // Garrison row
      const row = GARRISON_ROWS[dr - 1]!;
      const key = `${col}:${row}`;
      if (this.tool.kind === 'erase') {
        this.garrison.delete(key);
      } else if (this.tool.kind === 'unit') {
        if (!this.garrison.has(key) && this.garrison.size >= MAX_GARRISON) {
          this.showToast(t('world.defense.full'), C.red);
          return;
        }
        this.garrison.set(key, this.tool.type);
      } else {
        this.showToast(t('world.defense.buildingsNotHere'), C.red);
        return;
      }
    }
    this.render();
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  private showToast(msg: string, color: number = C.dark): void {
    this.toastLayer.removeChildren();
    const lbl = txt(msg, 13, color);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = this.w / 2; lbl.y = this.h - FOOTER_H - 24;
    this.toastLayer.addChild(lbl);
    this.toastTimer = 2200;
  }

  // ── Scene interface ───────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    for (const { rect, action } of this.hits) {
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
        action();
        return;
      }
    }
    this.onGridTap(x, y);
  }

  update(dt: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt * 1000;
      if (this.toastTimer <= 0) this.toastLayer.removeChildren();
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.container.destroy({ children: true });
  }
}
