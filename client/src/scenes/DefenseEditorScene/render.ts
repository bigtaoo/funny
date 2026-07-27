// Rendering for the defense editor: base-level stepper, palette, formation grid (units/buildings),
// attack-mode card roster + toolbar, and the footer/header action button clusters.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { UNIT_ART_URLS, getArtTexture } from '../../render/cardArt';
import { ATTACK_LANES, BASE_COLS } from '../../game/config';
import { UnitType, BuildingType } from '../../game/types';
import type { CardInstance } from '../../game/meta/SaveData';
import {
  type Constructor, type DefenseEditorSceneBaseCtor, type Tool,
  COLLECTED_UNITS, COLLECTED_BUILDINGS, nameKeyFor, PALETTE_H, FOOTER_H, PAD, MAX_BASE_LEVEL,
} from './base';

export interface RenderHandlers {
  renderBaseStepper(rightX: number, y: number): void;
  renderPalette(top: number): void;
  renderAttackBody(top: number, bottom: number): void;
  renderAttackToolbar(x: number, y: number, w: number, h: number): void;
  renderCardRosterPanel(x: number, y: number, w: number, h: number): void;
  renderRosterCell(
    c: { card: CardInstance; unitType: UnitType; troops: number; cap: number },
    x: number, y: number, cellW: number, cellH: number,
  ): void;
  drawArtFit(url: string, x: number, y: number, boxW: number, boxH: number): void;
  renderGrid(top: number, bottom: number, areaX?: number, areaW?: number): void;
  drawBuilding(g: PIXI.Graphics, px: number, py: number, cw: number, ch: number, type: BuildingType): void;
  drawUnit(g: PIXI.Graphics, px: number, py: number, cw: number, ch: number, type: UnitType, hp?: number, cap?: number, isLeader?: boolean): void;
  renderFooter(top: number): void;
  renderAttackHeaderControls(headerH: number): void;
  renderActionButtons(rightEdge: number, top: number, rowH: number, scale?: number): void;
}

export function RenderMixin<TBase extends DefenseEditorSceneBaseCtor>(Base: TBase): TBase & Constructor<RenderHandlers> {
  return class extends Base {
    renderBaseStepper(rightX: number, y: number): void {
      const btnW = 24, btnH = 24;
      const lbl = txt(t('world.defense.baseLevel').replace('{lv}', String(this.baseLevel)), FS.micro, C.dark);
      // [-] label [+] laid right-aligned
      const plus = sketchPanel(btnW, btnH, { fill: C.dark, border: C.gold, seed: seedFor(rightX, y, btnW) });
      plus.x = rightX - btnW; plus.y = y;
      this.bodyLayer.addChild(plus);
      const plusLbl = txt('+', FS.small, C.light); plusLbl.anchor.set(0.5, 0.5);
      plusLbl.x = plus.x + btnW / 2; plusLbl.y = plus.y + btnH / 2;
      this.bodyLayer.addChild(plusLbl);
      this.hits.push({ rect: { x: plus.x, y: plus.y, w: btnW, h: btnH }, action: () => {
        this.baseLevel = Math.min(MAX_BASE_LEVEL, this.baseLevel + 1); this.render();
      } });

      lbl.anchor.set(1, 0.5);
      lbl.x = plus.x - 6; lbl.y = y + btnH / 2;
      this.bodyLayer.addChild(lbl);

      const minus = sketchPanel(btnW, btnH, { fill: C.dark, border: C.gold, seed: seedFor(rightX, y + 1, btnW) });
      minus.x = lbl.x - lbl.width - 6 - btnW; minus.y = y;
      this.bodyLayer.addChild(minus);
      const minusLbl = txt('−', FS.small, C.light); minusLbl.anchor.set(0.5, 0.5);
      minusLbl.x = minus.x + btnW / 2; minusLbl.y = minus.y + btnH / 2;
      this.bodyLayer.addChild(minusLbl);
      this.hits.push({ rect: { x: minus.x, y: minus.y, w: btnW, h: btnH }, action: () => {
        this.baseLevel = Math.max(0, this.baseLevel - 1); this.render();
      } });
    }

    renderPalette(top: number): void {
      const { w } = this;
      const tools: { tool: Tool; label: string; tint: number }[] = [
        // Buildings are defense-mode only (attacker places units only).
        ...(this.hasBuildingRow ? COLLECTED_BUILDINGS.map((bt) => ({
          tool: { kind: 'building', type: bt } as Tool, label: t(nameKeyFor('building', bt)), tint: C.gold,
        })) : []),
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
        const lbl = txt(label, FS.micro, active ? C.light : C.dark, true);
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

    /**
     * Attack mode body: left half = formation grid (place cards into cells), right half = a scrollable
     * vertical card roster to pick from — mirrors 布阵(left)/选卡(right) so both stay visible together
     * instead of the old horizontal palette strip forcing a page-flip to see more cards.
     */
    renderAttackBody(top: number, bottom: number): void {
      const { w } = this;
      const gap = PAD;
      const leftW = Math.floor((w - PAD * 2 - gap) / 2);
      const rightX = PAD + leftW + gap;
      const rightW = w - PAD - rightX;

      const toolbarH = 30;
      this.renderAttackToolbar(PAD, top, leftW, toolbarH);
      this.renderGrid(top + toolbarH + 6, bottom, PAD, leftW);

      this.rosterX = rightX; this.rosterY = top; this.rosterW = rightW; this.rosterH = bottom - top;
      this.renderCardRosterPanel(rightX, top, rightW, bottom - top);
    }

    /** Hint text + 自动回城 toggle + erase toggle, sized to the left (grid) half only. */
    renderAttackToolbar(x: number, y: number, w: number, h: number): void {
      const eraseW = 60, eraseH = h - 6;
      const eraseX = x + w - eraseW;

      // 占领后自动回城 toggle (2026-07-23): a compact pill just left of the erase toggle. Off (default) = the team
      // stays stationed on a captured/moved-to tile; on = it marches home afterward.
      const arActive = this.autoReturn;
      const arW = 116, arH = eraseH;
      const arX = eraseX - 8 - arW;
      const arBox = sketchPanel(arW, arH, {
        fill: arActive ? C.gold : C.paper, border: arActive ? C.dark : C.gold,
        width: arActive ? 2.4 : 1.4, seed: seedFor(arX, y, arW),
      });
      arBox.x = arX; arBox.y = y + 3;
      this.bodyLayer.addChild(arBox);
      const arLbl = txt(`${t('world.team.autoReturn')} ${arActive ? '✓' : '✕'}`, FS.micro, arActive ? C.dark : C.gold, true);
      arLbl.anchor.set(0.5, 0.5); arLbl.x = arBox.x + arW / 2; arLbl.y = arBox.y + arH / 2;
      if (arLbl.width > arW - 8) arLbl.scale.set((arW - 8) / arLbl.width);
      this.bodyLayer.addChild(arLbl);
      this.hits.push({ rect: { x: arBox.x, y: arBox.y, w: arW, h: arH }, action: () => { this.autoReturn = !this.autoReturn; this.render(); } });

      // 领队 tool (2026-07-25): armed like the erase toggle — while it's active, tapping a placed card
      // makes that card the team's icon. Deliberately NOT a fixed "leader cell" on the grid: the leader is
      // an identity, and tying it to a square would force the player to break their formation to change it.
      const ldActive = this.tool.kind === 'leader';
      const ldW = 76, ldH = eraseH;
      const ldX = arX - 8 - ldW;
      const ldBox = sketchPanel(ldW, ldH, {
        fill: ldActive ? C.accent : C.paper, border: ldActive ? C.dark : C.accent,
        width: ldActive ? 2.4 : 1.4, seed: seedFor(ldX, y, ldW),
      });
      ldBox.x = ldX; ldBox.y = y + 3;
      this.bodyLayer.addChild(ldBox);
      const ldLbl = txt(`★ ${t('world.team.leader')}`, FS.micro, ldActive ? C.light : C.accent, true);
      ldLbl.anchor.set(0.5, 0.5); ldLbl.x = ldBox.x + ldW / 2; ldLbl.y = ldBox.y + ldH / 2;
      if (ldLbl.width > ldW - 8) ldLbl.scale.set((ldW - 8) / ldLbl.width);
      this.bodyLayer.addChild(ldLbl);
      this.hits.push({ rect: { x: ldBox.x, y: ldBox.y, w: ldW, h: ldH }, action: () => {
        this.tool = ldActive ? { kind: 'erase' } : { kind: 'leader' };
        this.render();
      } });

      const hint = txt(this.tool.kind === 'leader' ? t('world.team.leaderHint') : t('world.team.hint'), FS.micro, C.mid);
      hint.anchor.set(0, 0.5);
      hint.x = x; hint.y = y + h / 2;
      const hintMax = ldX - 8 - x;
      if (hint.width > hintMax) hint.scale.set(hintMax / hint.width);
      this.bodyLayer.addChild(hint);

      const eraseActive = this.tool.kind === 'erase';
      const box = sketchPanel(eraseW, eraseH, {
        fill: eraseActive ? C.red : C.paper, border: eraseActive ? C.dark : C.red,
        width: eraseActive ? 2.4 : 1.4, seed: seedFor(eraseX, y, eraseW),
      });
      box.x = eraseX; box.y = y + 3;
      this.bodyLayer.addChild(box);
      const lbl = txt(t('world.defense.erase'), FS.micro, eraseActive ? C.light : C.red, true);
      lbl.anchor.set(0.5, 0.5); lbl.x = box.x + eraseW / 2; lbl.y = box.y + eraseH / 2;
      this.bodyLayer.addChild(lbl);
      this.hits.push({ rect: { x: box.x, y: box.y, w: eraseW, h: eraseH }, action: () => { this.tool = { kind: 'erase' }; this.render(); } });
    }

    /** Right-half card roster: a scrollable portrait-card grid (mirrors TeamsScene's roster grid). */
    renderCardRosterPanel(x: number, y: number, w: number, h: number): void {
      const cards = this.availableCards();
      const titleH = 22;
      const title = txt(t('roster.title'), FS.micro, C.mid);
      title.x = x; title.y = y + 2;
      this.bodyLayer.addChild(title);

      const listY = y + titleH;
      const availH = h - titleH;
      if (cards.length === 0) {
        const empty = txt(t('world.team.noCards'), FS.micro, C.mid);
        empty.x = x; empty.y = listY + 8;
        this.bodyLayer.addChild(empty);
        this.scrollMax = 0;
        return;
      }

      const gap = 8;
      const cellWTarget = 168, cellH = 96;
      const cols = Math.max(1, Math.floor((w + gap) / (cellWTarget + gap)));
      const cellW = (w - gap * (cols - 1)) / cols;
      const rows = Math.ceil(cards.length / cols);
      const totalH = rows * (cellH + gap) + gap;
      // No PIXI mask backs this grid (draw-cull only, below) — a row is either drawn in full or
      // skipped entirely, never cropped, so peekViewportH's mid-row shrink would just exclude a
      // row that fits fine and leave a dead gap (2026-07-23 correction, UI_DESIGN.md §25). Use the
      // naive availH directly.
      this.scrollMax = Math.max(0, totalH - availH);
      this.scrollY = Math.max(0, Math.min(this.scrollY, this.scrollMax));

      cards.forEach((c, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cx = x + col * (cellW + gap);
        const cy = listY + gap + row * (cellH + gap) - this.scrollY;
        if (cy + cellH >= listY && cy <= listY + availH) this.renderRosterCell(c, cx, cy, cellW, cellH);
      });

      drawScrollIndicator(this.bodyLayer, { x, y: listY, w, h: availH }, this.scrollY, this.scrollMax);
    }

    renderRosterCell(
      c: { card: CardInstance; unitType: UnitType; troops: number; cap: number },
      x: number, y: number, cellW: number, cellH: number,
    ): void {
      const active = this.tool.kind === 'card' && this.tool.cardInstanceId === c.card.id;
      const placed = this.cellForCard(c.card.id) !== undefined;
      const pad = 6;
      const box = sketchPanel(cellW, cellH, {
        fill: active ? C.accent : 0xfaf9f5, border: active ? C.dark : (placed ? C.accent : C.mid),
        width: active ? 2.4 : 1.4, seed: seedFor(x, y, cellW),
      });
      box.x = x; box.y = y;
      this.bodyLayer.addChild(box);

      const imgH = cellH - pad * 2;
      const imgW = Math.round(imgH * 0.72);
      const frame = sketchPanel(imgW, imgH, { fill: 0xf0eee7, border: C.mid, seed: seedFor(x, y, imgW) });
      frame.x = x + pad; frame.y = y + pad;
      this.bodyLayer.addChild(frame);
      const artUrl = UNIT_ART_URLS[c.unitType];
      if (artUrl) this.drawArtFit(artUrl, x + pad + 1, y + pad + 1, imgW - 2, imgH - 2);

      const ax = x + pad + imgW + 8;
      const rightW = Math.max(10, x + cellW - pad - ax);
      const name = t(`card.${c.card.defId}.name` as import('../../i18n').TranslationKey);
      const nameLbl = txt(`${name} Lv.${c.card.level}`, FS.micro, active ? C.light : C.dark, true);
      nameLbl.x = ax; nameLbl.y = y + pad;
      if (nameLbl.width > rightW) nameLbl.scale.set(Math.max(0.5, rightW / nameLbl.width));
      this.bodyLayer.addChild(nameLbl);

      const troopLbl = txt(`${c.troops}/${c.cap}`, FS.micro, active ? C.light : C.mid);
      troopLbl.x = ax; troopLbl.y = y + pad + 18;
      this.bodyLayer.addChild(troopLbl);

      if (placed) {
        const tag = txt(`[${t('roster.inTeam')}]`, FS.micro, active ? C.light : C.accent, true);
        tag.x = ax; tag.y = y + pad + 36;
        this.bodyLayer.addChild(tag);
      }

      const rect = { x, y, w: cellW, h: cellH };
      this.hits.push({ rect, action: () => {
        this.tool = { kind: 'card', cardInstanceId: c.card.id, unitType: c.unitType };
        this.render();
      } });
      // Also expose this cell for drag-to-place (arm a drag candidate on pointer-down over it).
      this.rosterCardHits.push({ rect, cardId: c.card.id, unitType: c.unitType });
    }

    /** Draw a unit portrait fit into a box, centered; re-render once its texture loads (mirrors TeamsScene). */
    drawArtFit(url: string, x: number, y: number, boxW: number, boxH: number): void {
      const tex = getArtTexture(url);
      if (!tex.baseTexture.valid) {
        if (!this.artHooked.has(url)) {
          this.artHooked.add(url);
          tex.baseTexture.once('loaded', () => { if (!this.destroyed) this.render(); });
        }
        return;
      }
      const scale = Math.min(boxW / tex.width, boxH / tex.height);
      const sp = new PIXI.Sprite(tex);
      sp.anchor.set(0.5);
      sp.scale.set(scale);
      sp.position.set(x + boxW / 2, y + boxH / 2);
      this.bodyLayer.addChild(sp);
    }

    renderGrid(top: number, bottom: number, areaX: number = PAD, areaW: number = this.w - PAD * 2): void {
      const buildRows = this.hasBuildingRow ? 1 : 0;
      const rows = buildRows + this.gRows.length; // (defense: building row +) garrison rows
      const availW = areaW;
      const availH = bottom - top;
      const cellW = availW / 12;
      const cellH = Math.min(cellW, availH / rows);
      const gridW = cellW * 12;
      const gridH = cellH * rows;
      const gridX = areaX + (areaW - gridW) / 2;
      const gridY = top + (availH - gridH) / 2;
      this.gridX = gridX; this.gridY = gridY; this.cellW = cellW; this.cellH = cellH;

      const g = new PIXI.Graphics();
      this.bodyLayer.addChild(g);

      const attackSet = new Set<number>(ATTACK_LANES as readonly number[]);
      const [baseLo, baseHi] = BASE_COLS;
      const leaderId = this.effectiveLeaderId();

      // Display rows: (defense only) dr 0 = building row; remaining = this.gRows
      for (let dr = 0; dr < rows; dr++) {
        const isBuildingRow = this.hasBuildingRow && dr === 0;
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
              const b = this.buildings.get(col);
              if (b) this.drawBuilding(g, px, py, cellW, cellH, b);
            }
          } else {
            const row = this.gRows[dr - buildRows]!;
            if (isAttack) {
              const key = `${col}:${row}`;
              const u = this.garrison.get(key);
              if (u) {
                const cap = this.mode === 'attack' && u.cardInstanceId ? this.capForCard(u.cardInstanceId) : undefined;
                this.drawUnit(g, px, py, cellW, cellH, u.unitType, u.hp, cap, !!u.cardInstanceId && u.cardInstanceId === leaderId);
              }
            }
          }
        }
      }

      // Row label (left): defense → building row; attack → spawn row at the home row (bottom).
      const lbl = txt(this.hasBuildingRow ? t('world.defense.buildRow') : t('world.team.frontRow'), FS.micro, C.mid);
      lbl.anchor.set(1, 0.5);
      lbl.x = gridX - 3;
      lbl.y = this.hasBuildingRow ? gridY + cellH / 2 : gridY + (rows - 0.5) * cellH;
      this.bodyLayer.addChild(lbl);
    }

    drawBuilding(g: PIXI.Graphics, px: number, py: number, cw: number, ch: number, type: BuildingType): void {
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

    drawUnit(g: PIXI.Graphics, px: number, py: number, cw: number, ch: number, type: UnitType, hp?: number, cap?: number, isLeader = false): void {
      const cx = px + cw / 2, cy = py + ch / 2;
      const size = Math.min(cw, ch) * 0.72;
      const bx = cx - size / 2, by = cy - size / 2;
      const artUrl = UNIT_ART_URLS[type];
      if (artUrl) {
        const frame = sketchPanel(size, size, {
          // The leader wears a gold frame so its portrait reads as "this is the team" even before the ★.
          fill: 0xf0eee7, border: isLeader ? C.gold : 0x33425a, width: isLeader ? 2.4 : 1.2, seed: seedFor(px, py, size),
        });
        frame.x = bx; frame.y = by;
        this.bodyLayer.addChild(frame);
        this.drawArtFit(artUrl, bx + 1, by + 1, size - 2, size - 2);
      } else {
        const r = size / 2;
        g.lineStyle(1.2, 0x33425a, 1);
        g.beginFill(0x4477cc, 0.92);
        g.drawCircle(cx, cy, r);
        g.endFill();
      }

      // Attack mode: a troop bar above the head showing currentTroops / troopCap(card), green→amber→red by
      // fill ratio, so at-a-glance you see how many soldiers each on-field character carries.
      if (hp !== undefined && this.mode === 'attack' && cap && cap > 0) {
        const ratio = Math.max(0, Math.min(1, hp / cap));
        const barW = size, barH = 3, byBar = by - barH - 1;
        const barColor = ratio >= 0.66 ? 0x4caf50 : ratio >= 0.33 ? 0xe0a020 : 0xcc3b3b;
        g.beginFill(0x000000, 0.28);
        g.drawRect(bx, byBar, barW, barH);
        g.endFill();
        g.beginFill(barColor, 1);
        g.drawRect(bx, byBar, barW * ratio, barH);
        g.endFill();
      }

      // ★ badge on the team's leader (the card whose portrait represents the team elsewhere).
      if (isLeader) {
        const star = txt('★', FS.small, C.gold, true);
        star.anchor.set(0.5, 0.5);
        star.x = bx + size - 2; star.y = by + 2;
        this.bodyLayer.addChild(star);
      }

      // Live troop count under the icon — a card's cardState ledger, not a blueprint-relative HP fraction
      // (a card's troop count isn't bounded by the unit's base HP stat).
      if (hp !== undefined && this.mode === 'attack') {
        const label = txt(String(hp), FS.micro, 0x222222, true);
        label.anchor.set(0.5, 0);
        label.x = cx; label.y = by + size + 1;
        this.bodyLayer.addChild(label);
      }
    }

    /** Defense footer: counts + hint on the left, action buttons on the right. (Attack mode has no footer.) */
    renderFooter(top: number): void {
      const { w } = this;
      const panel = sketchPanel(w, FOOTER_H, { fill: C.paper, border: C.mid, seed: seedFor(0, top, w) });
      panel.y = top;
      this.bodyLayer.addChild(panel);

      const countsStr = `${t('world.defense.buildings')} ${this.buildings.size}   ${t('world.defense.garrison').replace('{n}', String(this.garrison.size))}`;
      const counts = txt(countsStr, FS.micro, C.dark);
      counts.x = PAD; counts.y = top + 8;
      this.bodyLayer.addChild(counts);

      const hint = txt(t('world.defense.hint'), FS.micro, C.mid);
      hint.x = PAD; hint.y = top + 26;
      this.bodyLayer.addChild(hint);

      this.renderActionButtons(w - PAD, top, FOOTER_H);
    }

    /**
     * Attack-mode header controls: the troop readout (garrison / committed / pool) at the top-left
     * (right of the back pill, scaled to clear the centred title) + the Fill/Clear/Save cluster at the
     * top-right — both drawn over the baked header chrome so the bottom footer band frees up entirely.
     */
    renderAttackHeaderControls(headerH: number): void {
      const { w } = this;
      const troopsStr = `${this.committedTroops()}/${this.teamCapacity()}`;
      // "Garrison N" used to head this readout, but in attack mode N is the number of hero cards placed,
      // not a garrison size — it sat next to the troop count and read as if the two measured the same thing.
      const countsStr = `${t('world.team.cards').replace('{n}', String(this.garrison.size))}   ${t('world.team.committed').replace('{n}', troopsStr)}   ${t('world.team.pool').replace('{n}', String(this.troops))}`;
      // ~2x the old FS.small readout — approved 2026-07-23 (user: PC screen, top-bar text too small).
      const counts = txt(countsStr, FS.title, C.dark, true);
      counts.anchor.set(0, 0.5);
      const startX = 210; // clears the back pill (constant width in the shared 1080 design space)
      counts.x = startX; counts.y = headerH / 2;
      // Keep clear of the horizontally-centred title (measure it to find its left edge).
      const titleNode = txt(this.titleText(), FS.headline, C.dark, true);
      const titleLeft = w / 2 - titleNode.width / 2;
      titleNode.destroy({ texture: true, baseTexture: true });
      const avail = titleLeft - 12 - startX;
      if (avail > 20 && counts.width > avail) counts.scale.set(avail / counts.width);
      this.bodyLayer.addChild(counts);

      // ~2x the shared button size, only in the roomy attack header (the defense footer keeps scale 1).
      this.renderActionButtons(w - PAD, 0, headerH, 2);
    }

    /**
     * Right-aligned Fill troops (attack only) / Clear / Save cluster, vertically centred on the band
     * [top, top+rowH] ending at `rightEdge`. Shared by the defense footer (scale 1) and the attack header
     * (scale 2 — the header band is tall enough and the PC readout needs to be legible).
     */
    renderActionButtons(rightEdge: number, top: number, rowH: number, scale = 1): void {
      const btnW = 70 * scale, btnH = 30 * scale, gap = 8 * scale;
      const labelSize = scale >= 2 ? FS.heading : FS.tiny;
      const cy = top + (rowH - btnH) / 2;
      const save = sketchPanel(btnW, btnH, { fill: C.dark, border: C.gold, seed: seedFor(rightEdge, top, btnW) });
      save.x = rightEdge - btnW; save.y = cy;
      this.bodyLayer.addChild(save);
      const saveLbl = txt(t('world.defense.save'), labelSize, C.light, true);
      saveLbl.anchor.set(0.5, 0.5);
      saveLbl.x = save.x + btnW / 2; saveLbl.y = save.y + btnH / 2;
      this.bodyLayer.addChild(saveLbl);
      this.hits.push({ rect: { x: save.x, y: save.y, w: btnW, h: btnH }, action: () => void this.doSave() });

      const clear = sketchPanel(btnW, btnH, { fill: C.paper, border: C.red, seed: seedFor(rightEdge, top + 1, btnW) });
      clear.x = save.x - btnW - gap; clear.y = cy;
      this.bodyLayer.addChild(clear);

      if (this.mode === 'attack') {
        const fillFull = this.teamCapacity() > 0 && this.committedTroops() >= this.teamCapacity();
        const fillW = 84 * scale;
        const fill = sketchPanel(fillW, btnH, { fill: C.paper, border: fillFull ? C.mid : C.gold, seed: seedFor(rightEdge, top + 2, fillW) });
        fill.x = clear.x - fillW - gap; fill.y = cy;
        this.bodyLayer.addChild(fill);
        const fillLbl = txt(t('world.team.fill'), labelSize, fillFull ? C.mid : C.dark, true);
        fillLbl.anchor.set(0.5, 0.5);
        fillLbl.x = fill.x + fillW / 2; fillLbl.y = fill.y + btnH / 2;
        if (fillLbl.width > fillW - 6) fillLbl.scale.set((fillW - 6) / fillLbl.width);
        this.bodyLayer.addChild(fillLbl);
        if (!fillFull) {
          this.hits.push({ rect: { x: fill.x, y: fill.y, w: fillW, h: btnH }, action: () => void this.doFillTroops() });
        }
      }
      const clearLbl = txt(t('world.defense.clear'), labelSize, C.red, true);
      clearLbl.anchor.set(0.5, 0.5);
      clearLbl.x = clear.x + btnW / 2; clearLbl.y = clear.y + btnH / 2;
      this.bodyLayer.addChild(clearLbl);
      this.hits.push({ rect: { x: clear.x, y: clear.y, w: btnW, h: btnH }, action: () => {
        this.buildings.clear(); this.garrison.clear(); this.baseLevel = 0; this.leaderCardId = null; this.render();
      } });
    }
  };
}
