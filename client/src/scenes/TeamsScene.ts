// TeamsScene — SLG attack team management (G3-2c §16.2, CC-4)
//
// Lists 5 attack formation template slots (committed troops / empty). Tapping a slot
// opens DefenseEditorScene (attack mode) to edit that team.
// CC-4: palette changes from unit-type list to card roster (CHARACTER_CARDS_DESIGN §8).
//   - Shows each deployed card's troop count + injury status from worldsvc cardState.
//   - "Fill All Troops" button distributes baseTroopStock evenly by troopCap priority.
//
// Layout (2026-07-15 redesign): the 5 formation slots became a 2-column card grid (portrait
// strip preview of the deployed cards + committed troops, dashed "+ tap to build" empty state)
// instead of a thin single-column list — mirrors the roster/skins card-grid language elsewhere
// in the game (see roster-card-fullheight-portrait / skins-tab-card-grid memories). The card
// roster underneath moved from a flat cut-off list to a scrollable portrait-card grid so it no
// longer silently truncates when the inventory overflows the screen.

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { Scene } from './SceneManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader, HEADER_ACCENT } from '../ui/widgets/SceneHeader';
import { drawScrollIndicator } from '../ui/widgets/ScrollIndicator';
import { BusyTracker } from '../ui/busyTracker';
import { UNIT_ART_URLS, getArtTexture } from '../render/cardArt';
import type { WorldApiClient, TeamTemplate, CardSLGState, PlayerWorldView } from '../net/WorldApiClient';
import type { SaveData, CardInstance } from '../game/meta/SaveData';
import type { UnitType } from '../game/types';
import { CARD_DEFS, troopCap } from '../game/meta/cardDefs';

/** Team slot cap (UI constant; the server's SIEGE_TEAM_CAP is authoritative). */
export const TEAM_CAP = 5;

export interface TeamsCallbacks {
  onBack(): void;
  /** Open the attack formation editor for a specific slot. */
  onEditTeam(teamId: string, teamName: string): void;
  /** Current authoritative save (for cardInv roster). */
  getSave(): SaveData;
  worldApi: WorldApiClient;
  worldId: string;
}

/** Fixed slot id/name (v1 does not support custom naming). */
export function teamSlotId(i: number): string {
  return `t${i + 1}`;
}
export function teamSlotName(i: number): string {
  return t('world.team.slot').replace('{n}', String(i + 1));
}

const PAD = 12;
const FILL_BTN_H = 38;
const FILL_BTN_GAP = 10;
const SECTION_LABEL_H = 22;

// ── Formation slot grid (5 teams → 2-col card grid) ─────────────────────────
const TEAM_COLS = 2;
const TEAM_GAP = 10;
const TEAM_CARD_H = 132;
const MINI_ICON = 34;
const MINI_ICON_GAP = 4;

// ── Card roster grid (scrollable, portrait cell) ────────────────────────────
const ROSTER_CELL_W_TARGET = 260;
const ROSTER_CELL_H = 108;
const ROSTER_GAP = 10;

export class TeamsScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: TeamsCallbacks;
  private readonly bt = new BusyTracker();

  private teams: TeamTemplate[] = [];
  private worldView: PlayerWorldView | null = null;
  private loading = true;
  private destroyed = false;
  private toastTimer = 0;

  private bodyLayer!: PIXI.Container;
  private toastLayer!: PIXI.Container;
  private hits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  private readonly unsubs: (() => void)[] = [];

  // Roster grid drag-scroll (see scroll-drag-throttle-pattern memory: never render() inline from
  // handleMove — a burst of pointermove events would rebuild the whole scene per event).
  private scrollY = 0;
  private scrollMax = 0;
  private dragStart: { x: number; y: number; scroll: number } | null = null;
  private scrollDirty = false;
  private rosterTop = 0;
  /** Portrait urls whose texture we've hooked for a one-shot re-render on load. */
  private readonly artHooked = new Set<string>();

  constructor(layout: ILayout, input: InputManager, cb: TeamsCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.container = new PIXI.Container();

    this.container.addChild(buildPaperBackground('teams', this.w, this.h));
    const decoC = buildDecorCLayer(this.w, this.h);
    if (decoC) this.container.addChild(decoC);
    this.bodyLayer = new PIXI.Container();
    this.container.addChild(this.bodyLayer);
    this.toastLayer = new PIXI.Container();
    this.container.addChild(this.toastLayer);

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((_x, y) => this.handleMove(y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [teams, worldView] = await Promise.all([
        this.cb.worldApi.getTeams(this.cb.worldId),
        this.cb.worldApi.getMe(this.cb.worldId),
      ]);
      if (!this.destroyed) {
        this.teams = teams;
        this.worldView = worldView;
      }
    } catch { /* offline — show empty slots */ }
    this.loading = false;
    if (!this.destroyed) this.render();
  }

  /** Total troops committed across all cards in a team (uses cardState if available). */
  private committedTroops(army: TeamTemplate['army']): number {
    const cardState = this.worldView?.cardState ?? {};
    let total = 0;
    for (const entry of army) {
      const cid = entry.cardInstanceId;
      if (cid) {
        total += cardState[cid]?.currentTroops ?? 0;
      } else {
        total += Math.max(0, Math.floor(entry.initialHp ?? 0));
      }
    }
    return total;
  }

  private render(): void {
    tearDownChildren(this.bodyLayer);
    this.hits = [];
    const { w, h } = this;

    // Header
    const hdr = drawSceneHeader(this.bodyLayer, w, h, t('world.team.title'), {
      variant: 'paper', accent: HEADER_ACCENT.slg,
    });
    this.hits.push({ rect: hdr.backRect, action: () => this.cb.onBack() });

    if (this.loading) {
      const lbl = txt(t('world.loading'), 13, C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = h / 2;
      this.bodyLayer.addChild(lbl);
      return;
    }

    let y = hdr.headerH + PAD;

    // ── Fill-troops button ─────────────────────────────────────────────────
    this.renderFillTroopsBtn(y);
    y += FILL_BTN_H + FILL_BTN_GAP;

    // ── Team slot grid (2-col cards) ────────────────────────────────────────
    y = this.renderTeamGrid(y);

    // ── Card roster palette (scrollable) ────────────────────────────────────
    y += 6;
    this.rosterTop = y;
    this.renderCardRoster(y);
  }

  /** 2-column card grid of the 5 formation slots. Returns the y just past the grid's bottom row. */
  private renderTeamGrid(startY: number): number {
    const { w } = this;
    const avail = w - PAD * 2;
    const cellW = (avail - TEAM_GAP * (TEAM_COLS - 1)) / TEAM_COLS;
    const rows = Math.ceil(TEAM_CAP / TEAM_COLS);
    const nowTeams = Date.now();
    const teamState = this.worldView?.teamState ?? {};
    const save = this.cb.getSave();

    for (let i = 0; i < TEAM_CAP; i++) {
      const col = i % TEAM_COLS;
      const row = Math.floor(i / TEAM_COLS);
      const x = PAD + col * (cellW + TEAM_GAP);
      const y = startY + row * (TEAM_CARD_H + TEAM_GAP);
      this.renderTeamCard(i, x, y, cellW, teamState, nowTeams, save);
    }
    return startY + rows * (TEAM_CARD_H + TEAM_GAP);
  }

  private renderTeamCard(
    i: number,
    x: number,
    y: number,
    cardW: number,
    teamState: Record<string, { injuredUntil?: number | null }>,
    now: number,
    save: SaveData,
  ): void {
    const id = teamSlotId(i);
    const team = this.teams.find((tm) => tm.id === id);
    const filled = !!team && team.army.length > 0;
    // ADR-026 §5: a team that lost a defensive wave is injury-locked and cannot defend until healed.
    const injuredUntil = teamState[id]?.injuredUntil ?? 0;
    const injured = injuredUntil > now;
    const pad = 10;

    const border = injured ? C.red : (filled ? C.accent : C.mid);
    const panel = sketchPanel(cardW, TEAM_CARD_H, {
      fill: filled ? 0xfaf9f5 : C.paper, border, width: filled ? 2.2 : 1.3,
      seed: seedFor(x, y, cardW),
    });
    panel.x = x; panel.y = y;
    this.bodyLayer.addChild(panel);

    const name = txt(team?.name || teamSlotName(i), 15, C.dark, true);
    name.x = x + pad; name.y = y + pad;
    this.bodyLayer.addChild(name);

    // Edit chip (top-right) — whole card is also tappable, this is just an explicit affordance.
    const editW = 46, editH = 22;
    const editBtn = sketchPanel(editW, editH, { fill: C.dark, border: C.gold, seed: seedFor(x + cardW, y, editW) });
    editBtn.x = x + cardW - pad - editW; editBtn.y = y + pad - 3;
    this.bodyLayer.addChild(editBtn);
    const editLbl = txt(t('world.team.edit'), 10, C.light, true);
    editLbl.anchor.set(0.5, 0.5);
    editLbl.x = editBtn.x + editW / 2; editLbl.y = editBtn.y + editH / 2;
    this.bodyLayer.addChild(editLbl);

    if (injured) {
      const secsLeft = Math.ceil((injuredUntil - now) / 1000);
      const timeStr = secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)}m` : `${secsLeft}s`;
      const tag = txt(`[${t('roster.injured').replace('{time}', timeStr)}]`, 10, C.red, true);
      tag.x = x + pad; tag.y = y + pad + 20;
      this.bodyLayer.addChild(tag);
    }

    if (filled) {
      // Mini portrait strip: one small icon per deployed card (up to 6, then "+N").
      const entries = team!.army;
      const shown = entries.slice(0, 6);
      const iconsY = y + pad + (injured ? 42 : 30);
      let ix = x + pad;
      for (const entry of shown) {
        const cardInst = entry.cardInstanceId ? save.cardInv?.[entry.cardInstanceId] : undefined;
        const def = cardInst ? CARD_DEFS[cardInst.defId] : undefined;
        const unitType = (def?.unitType ?? entry.unitType) as UnitType | undefined;
        const artUrl = unitType ? UNIT_ART_URLS[unitType] : undefined;
        const frame = sketchPanel(MINI_ICON, MINI_ICON, { fill: 0xf0eee7, border: C.mid, seed: seedFor(ix, iconsY, MINI_ICON) });
        frame.x = ix; frame.y = iconsY;
        this.bodyLayer.addChild(frame);
        if (artUrl) this.drawArtFit(artUrl, ix + 1, iconsY + 1, MINI_ICON - 2, MINI_ICON - 2);
        ix += MINI_ICON + MINI_ICON_GAP;
      }
      if (entries.length > shown.length) {
        const more = txt(`+${entries.length - shown.length}`, 12, C.mid, true);
        more.x = ix + 2; more.y = iconsY + MINI_ICON / 2 - 7;
        this.bodyLayer.addChild(more);
      }

      const committed = this.committedTroops(team!.army);
      const sub = `${t('world.defense.garrison').replace('{n}', String(team!.army.length))}   ${t('world.team.committed').replace('{n}', String(committed))}`;
      const subLbl = txt(sub, 11, C.mid);
      subLbl.x = x + pad; subLbl.y = y + TEAM_CARD_H - pad - 14;
      this.bodyLayer.addChild(subLbl);
    } else {
      const plus = txt('+', 30, C.light, true);
      plus.anchor.set(0.5, 0.5); plus.x = x + cardW / 2; plus.y = y + TEAM_CARD_H / 2 - 10;
      this.bodyLayer.addChild(plus);
      const hint = txt(t('world.team.tapToBuild'), 11, C.light);
      hint.anchor.set(0.5, 0.5); hint.x = x + cardW / 2; hint.y = y + TEAM_CARD_H / 2 + 18;
      this.bodyLayer.addChild(hint);
    }

    const name2 = team?.name || teamSlotName(i);
    this.hits.push({
      rect: { x, y, w: cardW, h: TEAM_CARD_H },
      action: () => this.cb.onEditTeam(id, name2),
    });
  }

  private renderFillTroopsBtn(y: number): void {
    const { w } = this;
    const stock = this.worldView?.baseTroopStock ?? 0;
    const enabled = stock > 0 && !this.bt.busy;
    const btnW = w - PAD * 2;
    const btn = sketchPanel(btnW, FILL_BTN_H, {
      fill: enabled ? C.dark : C.btnOff,
      border: enabled ? C.gold : C.mid,
      seed: seedFor(PAD, y, btnW),
    });
    btn.x = PAD; btn.y = y;
    this.bodyLayer.addChild(btn);

    const label = txt(
      `${t('world.team.fillTroops')}  (${stock} ${t('world.troops')})`,
      13, enabled ? C.light : C.mid, true,
    );
    label.anchor.set(0.5, 0.5); label.x = PAD + btnW / 2; label.y = y + FILL_BTN_H / 2;
    this.bodyLayer.addChild(label);

    if (enabled) {
      this.hits.push({
        rect: { x: PAD, y, w: btnW, h: FILL_BTN_H },
        action: () => void this.doFillTroops(),
      });
    }
  }

  /** Card roster section: scrollable portrait-card grid of all cards in cardInv with troop / injury status. */
  private renderCardRoster(startY: number): void {
    const { w, h } = this;
    const save = this.cb.getSave();
    const cardState = this.worldView?.cardState ?? {};
    const cardInv = save.cardInv ?? {};
    const cards = Object.values(cardInv);

    if (cards.length === 0) return;

    const sectionLbl = txt(t('roster.title'), 11, C.mid);
    sectionLbl.x = PAD; sectionLbl.y = startY + 2;
    this.bodyLayer.addChild(sectionLbl);

    const listY = startY + SECTION_LABEL_H;
    const listH = h - listY - 8;
    const avail = w - PAD * 2;
    const cols = Math.max(1, Math.floor((avail + ROSTER_GAP) / (ROSTER_CELL_W_TARGET + ROSTER_GAP)));
    const cellW = (avail - ROSTER_GAP * (cols - 1)) / cols;
    const rows = Math.ceil(cards.length / cols);
    const totalH = rows * (ROSTER_CELL_H + ROSTER_GAP) + ROSTER_GAP;
    this.scrollMax = Math.max(0, totalH - listH);
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.scrollMax));

    const now = Date.now();
    cards.forEach((card, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = PAD + col * (cellW + ROSTER_GAP);
      const y = listY + ROSTER_GAP + row * (ROSTER_CELL_H + ROSTER_GAP) - this.scrollY;
      if (y + ROSTER_CELL_H >= listY && y <= listY + listH) {
        this.renderCardRosterCell(card, x, y, cellW, cardState[card.id], now);
      }
    });

    drawScrollIndicator(this.bodyLayer, { x: PAD, y: listY, w: avail, h: listH }, this.scrollY, this.scrollMax);
  }

  private renderCardRosterCell(
    card: CardInstance,
    x: number,
    y: number,
    cellW: number,
    state: CardSLGState | undefined,
    now: number,
  ): void {
    const def = CARD_DEFS[card.defId];
    const cap = def ? troopCap(card) : 0;
    const current = state?.currentTroops ?? 0;
    const injuredUntil = state?.injuredUntil ?? 0;
    const isInjured = injuredUntil > now;
    const teamId = state?.teamId;
    const pad = 8;

    const border = isInjured ? C.red : (teamId ? C.accent : C.mid);
    const cell = sketchPanel(cellW, ROSTER_CELL_H, { fill: 0xfaf9f5, border, seed: seedFor(x, y, cellW) });
    cell.x = x; cell.y = y;
    this.bodyLayer.addChild(cell);

    // Portrait (spans the cell height, left side).
    const imgH = ROSTER_CELL_H - pad * 2;
    const imgW = Math.round(imgH * 0.72);
    const frame = sketchPanel(imgW, imgH, { fill: 0xf0eee7, border: C.mid, seed: seedFor(x, y, imgW) });
    frame.x = x + pad; frame.y = y + pad;
    this.bodyLayer.addChild(frame);
    const artUrl = def ? UNIT_ART_URLS[def.unitType] : undefined;
    if (artUrl) this.drawArtFit(artUrl, x + pad + 1, y + pad + 1, imgW - 2, imgH - 2);

    // Info column.
    const ax = x + pad + imgW + 10;
    const rightW = x + cellW - pad - ax;
    const cardName = t(`card.${card.defId}.name` as import('../i18n').TranslationKey);
    const nameLbl = txt(`${cardName} Lv.${card.level}`, 13, C.dark, true);
    nameLbl.x = ax; nameLbl.y = y + pad;
    if (nameLbl.width > rightW) nameLbl.scale.set(rightW / nameLbl.width);
    this.bodyLayer.addChild(nameLbl);

    const troopLbl = txt(
      `${current}/${cap}`,
      13,
      current >= cap ? C.gold : (current === 0 ? C.mid : C.dark),
    );
    troopLbl.x = ax; troopLbl.y = y + pad + 24;
    this.bodyLayer.addChild(troopLbl);

    if (teamId) {
      const tag = txt(`[${t('roster.inTeam')}]`, 11, C.accent, true);
      tag.x = ax; tag.y = y + pad + 46; this.bodyLayer.addChild(tag);
    } else if (isInjured) {
      const secsLeft = Math.ceil((injuredUntil - now) / 1000);
      const timeStr = secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)}m` : `${secsLeft}s`;
      const tag = txt(`[${t('roster.injured').replace('{time}', timeStr)}]`, 11, C.red);
      tag.x = ax; tag.y = y + pad + 46; this.bodyLayer.addChild(tag);
    }
  }

  /**
   * Draw a unit portrait, centered & fit into a box; re-render once the texture loads.
   * Scales to whichever axis is tighter so it never clips or stretches (mirrors CardScene's helper).
   */
  private drawArtFit(url: string, x: number, y: number, boxW: number, boxH: number): void {
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

  // ── Actions ─────────────────────────────────────────────────────────────

  private async doFillTroops(): Promise<void> {
    if (this.bt.busy) return;
    this.bt.start(); this.render();
    try {
      const save = this.cb.getSave();
      const cardState = this.worldView?.cardState ?? {};
      const cardInv = save.cardInv ?? {};
      const stock = this.worldView?.baseTroopStock ?? 0;
      if (stock <= 0) return;

      // Build allocations: fill each card up to troopCap, highest-deficit first.
      const allocations: Record<string, number> = {};
      let remaining = stock;

      // Sort by deficit descending (most empty first) to match the "power-desc" design intent.
      const slots = Object.values(cardInv)
        .map(card => {
          const def = CARD_DEFS[card.defId];
          const cap = def ? troopCap(card) : 0;
          const cur = cardState[card.id]?.currentTroops ?? 0;
          return { card, gap: Math.max(0, cap - cur) };
        })
        .filter(s => s.gap > 0)
        .sort((a, b) => b.gap - a.gap);

      for (const { card, gap } of slots) {
        if (remaining <= 0) break;
        const give = Math.min(gap, remaining);
        allocations[card.id] = give;
        remaining -= give;
      }

      if (Object.keys(allocations).length === 0) {
        this.showToast(t('world.team.fillTroopsOk'), C.green);
        return;
      }

      await this.cb.worldApi.distributeTroops(this.cb.worldId, allocations);
      // Refresh world view after distribution.
      this.worldView = await this.cb.worldApi.getMe(this.cb.worldId);
      this.showToast(t('world.team.fillTroopsOk'), C.green);
    } catch {
      this.showToast(t('world.team.fillTroopsErr'), C.red);
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  // ── Toast ────────────────────────────────────────────────────────────────

  private showToast(msg: string, color: number): void {
    const tl = this.toastLayer;
    tl.removeChildren();
    const lbl = txt(msg, 13, 0xffffff, true);
    const padX = 14, padY = 8;
    const bw = lbl.width + padX * 2;
    const bh = lbl.height + padY * 2;
    const bx = (this.w - bw) / 2;
    const by = this.h - 92;
    const bg = sketchPanel(bw, bh, { fill: color, fillAlpha: 0.96, border: color, seed: seedFor(bw, bh, 3) });
    bg.x = bx; bg.y = by;
    tl.addChild(bg);
    lbl.anchor.set(0.5, 0.5); lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
    tl.addChild(lbl);
    this.toastTimer = 2200;
  }

  // ── Input / lifecycle ────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    for (const { rect, action } of this.hits) {
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
        action();
        return;
      }
    }
    // No hit (e.g. pressed in the roster grid) — could be the start of a drag-scroll.
    if (y >= this.rosterTop) this.dragStart = { x, y, scroll: this.scrollY };
  }

  private handleMove(y: number): void {
    if (!this.dragStart) return;
    const dy = y - this.dragStart.y;
    if (Math.abs(dy) > 6) {
      this.scrollY = Math.max(0, Math.min(this.scrollMax, this.dragStart.scroll - dy));
      this.scrollDirty = true;
    }
  }

  private handleUp(): void {
    this.dragStart = null;
  }

  update(dt: number): void {
    // Drain the drag-scroll flag once per frame instead of rendering inline from handleMove
    // (see scroll-drag-throttle-pattern memory — a pointermove burst would otherwise rebuild
    // the whole scene per event).
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
    if (this.bt.tick(dt)) this.render();
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
