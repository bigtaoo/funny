// TeamsScene — SLG attack team management (G3-2c §16.2, CC-4)
//
// Lists 5 attack formation template slots (committed troops / empty). Tapping a slot
// opens DefenseEditorScene (attack mode) to edit that team.
// CC-4: palette changes from unit-type list to card roster (CHARACTER_CARDS_DESIGN §8).
//   - Shows each deployed card's troop count + injury status from worldsvc cardState.
//   - "Fill All Troops" button distributes baseTroopStock evenly by troopCap priority.

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { Scene } from './SceneManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader, HEADER_ACCENT } from '../ui/widgets/SceneHeader';
import { BusyTracker } from '../ui/busyTracker';
import type { WorldApiClient, TeamTemplate, CardSLGState, PlayerWorldView } from '../net/WorldApiClient';
import type { SaveData, CardInstance } from '../game/meta/SaveData';
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

const HEADER_H = 46;
const PAD = 12;
const ROW_H = 56;
const ROW_GAP = 8;
const FILL_BTN_H = 38;
const FILL_BTN_GAP = 10;
const CARD_ROW_H = 40;
const CARD_ROW_GAP = 4;
const SECTION_LABEL_H = 22;

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
      variant: 'paper', headerH: HEADER_H, titleSize: 14, accent: HEADER_ACCENT.slg,
    });
    this.hits.push({ rect: hdr.backRect, action: () => this.cb.onBack() });

    if (this.loading) {
      const lbl = txt(t('world.loading'), 13, C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = h / 2;
      this.bodyLayer.addChild(lbl);
      return;
    }

    let y = HEADER_H + PAD;

    // ── Fill-troops button ─────────────────────────────────────────────────
    this.renderFillTroopsBtn(y);
    y += FILL_BTN_H + FILL_BTN_GAP;

    // ── Team slot rows ─────────────────────────────────────────────────────
    const nowTeams = Date.now();
    const teamState = this.worldView?.teamState ?? {};
    for (let i = 0; i < TEAM_CAP; i++) {
      const id = teamSlotId(i);
      const team = this.teams.find((tm) => tm.id === id);
      const filled = !!team && team.army.length > 0;
      // ADR-026 §5: a team that lost a defensive wave is injury-locked and cannot defend until healed.
      const teamInjuredUntil = teamState[id]?.injuredUntil ?? 0;
      const teamInjured = teamInjuredUntil > nowTeams;
      const rowW = w - PAD * 2;
      const panel = sketchPanel(rowW, ROW_H, {
        fill: C.paper, border: teamInjured ? C.red : (filled ? C.accent : C.mid), width: filled ? 2 : 1.3,
        seed: seedFor(PAD, y, rowW),
      });
      panel.x = PAD; panel.y = y;
      this.bodyLayer.addChild(panel);

      const name = txt(team?.name || teamSlotName(i), 14, C.dark, true);
      name.x = PAD + 12; name.y = y + 10;
      this.bodyLayer.addChild(name);

      if (teamInjured) {
        const secsLeft = Math.ceil((teamInjuredUntil - nowTeams) / 1000);
        const timeStr = secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)}m` : `${secsLeft}s`;
        const tag = txt(`[${t('roster.injured').replace('{time}', timeStr)}]`, 10, C.red, true);
        tag.x = name.x + name.width + 8; tag.y = y + 12;
        this.bodyLayer.addChild(tag);
      }

      if (filled) {
        const committed = this.committedTroops(team!.army);
        const sub = `${t('world.defense.garrison').replace('{n}', String(team!.army.length))}   ${t('world.team.committed').replace('{n}', String(committed))}`;
        const subLbl = txt(sub, 11, C.mid);
        subLbl.x = PAD + 12; subLbl.y = y + 30;
        this.bodyLayer.addChild(subLbl);
      } else {
        const subLbl = txt(t('world.team.empty'), 11, C.light);
        subLbl.x = PAD + 12; subLbl.y = y + 30;
        this.bodyLayer.addChild(subLbl);
      }

      // Edit button (right)
      const btnW = 64, btnH = 30;
      const btn = sketchPanel(btnW, btnH, { fill: C.dark, border: C.gold, seed: seedFor(w, y, btnW) });
      btn.x = w - PAD - btnW - 8; btn.y = y + (ROW_H - btnH) / 2;
      this.bodyLayer.addChild(btn);
      const btnLbl = txt(t('world.team.edit'), 12, C.light, true);
      btnLbl.anchor.set(0.5, 0.5);
      btnLbl.x = btn.x + btnW / 2; btnLbl.y = btn.y + btnH / 2;
      this.bodyLayer.addChild(btnLbl);

      const name2 = team?.name || teamSlotName(i);
      this.hits.push({
        rect: { x: PAD, y, w: rowW, h: ROW_H },
        action: () => this.cb.onEditTeam(id, name2),
      });
      y += ROW_H + ROW_GAP;
    }

    // ── Card roster palette ────────────────────────────────────────────────
    y += 6;
    this.renderCardRoster(y);
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

  /** Card roster section: lists all cards from cardInv with their troop / injury status. */
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
    let y = startY + SECTION_LABEL_H;
    const now = Date.now();

    for (const card of cards) {
      if (y + CARD_ROW_H > h - 8) break; // stop before clipping off screen
      this.renderCardRosterRow(card, y, cardState[card.id], now);
      y += CARD_ROW_H + CARD_ROW_GAP;
    }
  }

  private renderCardRosterRow(
    card: CardInstance,
    y: number,
    state: CardSLGState | undefined,
    now: number,
  ): void {
    const { w } = this;
    const def = CARD_DEFS[card.defId];
    const cap = def ? troopCap(card) : 0;
    const current = state?.currentTroops ?? 0;
    const injuredUntil = state?.injuredUntil ?? 0;
    const isInjured = injuredUntil > now;
    const teamId = state?.teamId;

    const rowW = w - PAD * 2;
    const border = isInjured ? C.red : (teamId ? C.accent : C.mid);
    const row = sketchPanel(rowW, CARD_ROW_H - 2, { fill: 0xfaf9f5, border, seed: seedFor(y, 0, rowW) });
    row.x = PAD; row.y = y;
    this.bodyLayer.addChild(row);

    // Card name
    const cardName = t(`card.${card.defId}.name` as import('../i18n').TranslationKey);
    const nameLbl = txt(`${cardName} Lv.${card.level}`, 12, C.dark, true);
    nameLbl.x = PAD + 10; nameLbl.y = y + 5;
    this.bodyLayer.addChild(nameLbl);

    // Status tags: teamId / injured
    let tagX = nameLbl.x + nameLbl.width + 8;
    if (teamId) {
      const tag = txt(`[${t('roster.inTeam')}]`, 10, C.accent, true);
      tag.x = tagX; tag.y = y + 7; this.bodyLayer.addChild(tag); tagX += tag.width + 6;
    }
    if (isInjured) {
      const secsLeft = Math.ceil((injuredUntil - now) / 1000);
      const timeStr = secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)}m` : `${secsLeft}s`;
      const tag = txt(`[${t('roster.injured').replace('{time}', timeStr)}]`, 10, C.red);
      tag.x = tagX; tag.y = y + 7; this.bodyLayer.addChild(tag);
    }

    // Troop count (right side)
    const troopLbl = txt(
      `${current}/${cap}`,
      11,
      current >= cap ? C.gold : (current === 0 ? C.mid : C.dark),
    );
    troopLbl.anchor.set(1, 0.5); troopLbl.x = PAD + rowW - 10; troopLbl.y = y + (CARD_ROW_H - 2) / 2;
    this.bodyLayer.addChild(troopLbl);
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
  }

  update(dt: number): void {
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
