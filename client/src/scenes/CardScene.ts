// CardScene — Hero Roster UI (CHARACTER_CARDS_DESIGN §10).
//
// Two views:
//   List: card inventory sorted by power desc → level desc; capacity counter (n/150).
//         Each card row shows: icon, name, level, power, troop count, injury timer, gear slots, lock badge.
//   Detail modal: stats + skill + troop cap + gear 3 slots + XP progress bar + lock toggle + feed entry + list-auction.
//
// Feed flow (modal-within-modal): select target → tap "Feed Cards" → material selection panel
//   (same-faction filter, multi-select) → confirm → feedCards() API.
//
// Server-authoritative (L2): all mutations go through server endpoints; SaveData is the read-only mirror.
// SLG troop/injury data comes from worldsvc (PlayerWorldView.cardState); absent if not in SLG.

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { Scene } from './SceneManager';
import { t, type TranslationKey } from '../i18n';
import {
  ui as C, txt, buildPaperBackground, sketchPanel, seedFor,
  drawLoadingOverlay, tearDownChildren,
} from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawHubTabs, hubTabsHeight, type HubTab } from '../ui/widgets/HubTabs';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import type { SaveData, CardInstance, EquipSlot } from '../game/meta/SaveData';
import type { CardSLGState } from '../net/WorldApiClient';
import {
  CARD_DEFS, CARD_INV_CAP, CARD_INV_WARN,
  LEVEL_CUMULATIVE_XP, xpToNextLevel, troopCap, cardPower,
  type CardDef,
} from '../game/meta/cardDefs';

export type CardActionResult = { ok: true } | { ok: false; key: TranslationKey };

export interface CardCallbacks {
  onBack(): void;
  getSave(): SaveData;
  /** SLG per-card state (troops/injury/teamId); undefined when outside SLG. */
  getCardState?(): Record<string, CardSLGState> | undefined;
  /** Feed cards: consumes materialCardIds, grants XP to targetCardId. */
  feedCards(targetCardId: string, materialCardIds: string[]): Promise<CardActionResult & { levelsGained?: number }>;
  /** Toggle card lock. */
  setCardLock(cardInstanceId: string, locked: boolean): Promise<CardActionResult>;
  /** Recover an injured card by spending coins. Only present when in SLG context. */
  recoverCard?(cardInstanceId: string): Promise<CardActionResult>;
  /** Navigate to equipment scene for a specific card. */
  openEquipment?(cardInstanceId: string): void;
  /**
   * Open the equipment bag as a peer of the roster (LOBBY_IA_REDESIGN). When injected, a
   * [Cards|Equipment] group tab strip is shown; tapping Equipment enters the bag (no active card).
   */
  openEquipmentBag?(): void;
}

const HUD_H = 50;
const RES_H = 28;
const ROW_H = 64;
const MODAL_DIM = 0x000000;

interface Rect { x: number; y: number; w: number; h: number; }

/** Sort cards: power descending, then level descending, then id for stability. */
function sortCards(cards: CardInstance[], equipInv: SaveData['equipmentInv']): CardInstance[] {
  return [...cards].sort((a, b) => {
    const pd = cardPower(b, equipInv) - cardPower(a, equipInv);
    if (pd !== 0) return pd;
    if (b.level !== a.level) return b.level - a.level;
    return a.id < b.id ? -1 : 1;
  });
}

/** Human-readable countdown string for injuredUntil timestamp. */
function injuryCountdown(injuredUntil: number, now: number): string {
  const secsLeft = Math.max(0, Math.ceil((injuredUntil - now) / 1000));
  return secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)}m` : `${secsLeft}s`;
}

/** Cumulative XP to reach `level` from level 1 (index-safe). */
function cumXp(level: number): number {
  return LEVEL_CUMULATIVE_XP[Math.max(1, Math.min(level, 9))] ?? 0;
}

export class CardScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: CardCallbacks;
  private readonly bt = new BusyTracker();

  private bodyLayer!: PIXI.Container;
  private modalLayer!: PIXI.Container;
  private toastLayer!: PIXI.Container;
  private loadingLayer!: PIXI.Container;

  private backRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private hitRects: { rect: Rect; action: () => void }[] = [];
  private modalHits: { rect: Rect; action: () => void }[] = [];
  private modalOpen = false;

  private detailId: string | null = null;
  private scrollY = 0;
  private dragStart: { x: number; y: number; scroll: number } | null = null;
  /** Height of the [Cards|Equipment] group strip; >0 only when openEquipmentBag is injected. */
  private readonly groupH: number;

  private toastTimer = 0;
  private destroyed = false;
  private readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: CardCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.groupH = cb.openEquipmentBag ? hubTabsHeight(this.h) : 0;
    this.container = new PIXI.Container();
    this.build();
    this.render();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((_x, y) => this.handleMove(y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
  }

  private build(): void {
    const { w, h } = this;
    this.container.addChild(buildPaperBackground('cardbg', w, h));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    this.bodyLayer = new PIXI.Container();
    this.container.addChild(this.bodyLayer);
    this.modalLayer = new PIXI.Container();
    this.container.addChild(this.modalLayer);
    this.toastLayer = new PIXI.Container();
    this.container.addChild(this.toastLayer);
    this.loadingLayer = new PIXI.Container();
    this.container.addChild(this.loadingLayer);

    const hdr = drawSceneHeader(this.container, w, h, t('roster.title'), {
      variant: 'paper', headerH: HUD_H, titleSize: 15,
    });
    this.backRect = hdr.backRect;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.bodyLayer);
    this.hitRects = [];
    this.loadingLayer.removeChildren();
    this.hitRects.push({ rect: this.backRect, action: () => this.cb.onBack() });

    this.renderGroupTabs();
    this.renderCapacityBar();
    this.renderList();

    if (this.detailId) this.openDetail(this.detailId);
    else if (this.modalOpen) this.closeModal();

    if (this.bt.loadingVisible) drawLoadingOverlay(this.loadingLayer, this.w, this.h, this.bt.dots, t('common.processing'));
  }

  /**
   * Progression group tab strip [Cards|Equipment] (LOBBY_IA_REDESIGN): Cards is active; tapping
   * Equipment opens the equipment bag (openEquipmentBag). Drawn only when injected (groupH>0).
   */
  private renderGroupTabs(): void {
    if (this.groupH <= 0) return;
    const tabs: HubTab[] = [
      { label: t('roster.title'), active: true, icon: 'cards' },
      { label: t('equip.title'), active: false, icon: 'armor' },
    ];
    const hits = drawHubTabs(this.bodyLayer, this.w, HUD_H, this.groupH, tabs, (i) => {
      if (i === 1) this.cb.openEquipmentBag?.();
    });
    for (const hit of hits) this.hitRects.push({ rect: hit.rect, action: hit.fn });
  }

  private renderCapacityBar(): void {
    const { w } = this;
    const save = this.cb.getSave();
    const count = Object.keys(save.cardInv ?? {}).length;
    const warn = count >= CARD_INV_WARN;
    const full = count >= CARD_INV_CAP;
    const top = HUD_H + this.groupH;

    const bg = new PIXI.Graphics();
    bg.beginFill(0xf3f1ea).drawRect(0, top, w, RES_H).endFill();
    this.bodyLayer.addChild(bg);

    const capLbl = txt(
      `${t('roster.capacity').replace('{cur}', String(count)).replace('{cap}', String(CARD_INV_CAP))}`,
      11, full ? C.red : warn ? C.gold : C.mid,
    );
    capLbl.anchor.set(1, 0.5); capLbl.x = w - 10; capLbl.y = top + RES_H / 2;
    this.bodyLayer.addChild(capLbl);
  }

  private renderList(): void {
    const { w, h } = this;
    const save = this.cb.getSave();
    const cardState = this.cb.getCardState?.() ?? {};
    const cards = Object.values(save.cardInv ?? {});
    const listY = HUD_H + this.groupH + RES_H;
    const listH = h - listY - 8;

    if (cards.length === 0) {
      const lbl = txt(t('roster.empty'), 12, C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + listH / 2;
      lbl.style.wordWrap = true; lbl.style.wordWrapWidth = w - 32;
      this.bodyLayer.addChild(lbl);
      return;
    }

    const sorted = sortCards(cards, save.equipmentInv ?? {});
    const totalH = sorted.length * ROW_H;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));

    const now = Date.now();
    let cy = listY - this.scrollY;
    for (const card of sorted) {
      if (cy + ROW_H >= listY && cy <= listY + listH) {
        this.renderCardRow(card, cy, cardState[card.id], now, save);
      }
      cy += ROW_H;
    }
  }

  private renderCardRow(
    card: CardInstance,
    cy: number,
    state: CardSLGState | undefined,
    now: number,
    save: SaveData,
  ): void {
    const { w } = this;
    const def = CARD_DEFS[card.defId];
    const injuredUntil = state?.injuredUntil ?? 0;
    const isInjured = injuredUntil > now;
    const inTeam = !!state?.teamId;

    const border = isInjured ? C.red : (inTeam ? C.accent : C.mid);
    const row = sketchPanel(w - 12, ROW_H - 4, { fill: 0xfaf9f5, border, seed: seedFor(cy, 0, w) });
    row.x = 6; row.y = cy;
    this.bodyLayer.addChild(row);

    // Faction dot
    const factionColor = def?.faction === 'anna' ? 0xcc4466 : 0x4477cc;
    const dot = new PIXI.Graphics();
    dot.beginFill(factionColor).drawCircle(0, 0, 5).endFill();
    dot.x = 18; dot.y = cy + 18;
    this.bodyLayer.addChild(dot);

    // Name + level
    const cardName = t(`card.${card.defId}.name` as TranslationKey);
    const nameLbl = txt(`${cardName}`, 13, C.dark, true);
    nameLbl.x = 30; nameLbl.y = cy + 8;
    this.bodyLayer.addChild(nameLbl);

    const lvLbl = txt(`Lv.${card.level}`, 11, C.mid);
    lvLbl.x = 30; lvLbl.y = cy + 26;
    this.bodyLayer.addChild(lvLbl);

    // Power score
    const power = Math.round(cardPower(card, save.equipmentInv ?? {}));
    const pwrLbl = txt(`${t('roster.power')} ${power}`, 10, C.dark);
    pwrLbl.x = 30 + lvLbl.width + 10; pwrLbl.y = cy + 27;
    this.bodyLayer.addChild(pwrLbl);

    // Tags: locked / inTeam / injured
    let tagX = nameLbl.x + nameLbl.width + 8;
    if (card.locked) {
      const tag = txt(`[${t('roster.locked')}]`, 10, C.mid);
      tag.x = tagX; tag.y = cy + 10; this.bodyLayer.addChild(tag); tagX += tag.width + 4;
    }
    if (inTeam) {
      const tag = txt(`[${t('roster.inTeam')}]`, 10, C.accent, true);
      tag.x = tagX; tag.y = cy + 10; this.bodyLayer.addChild(tag); tagX += tag.width + 4;
    }
    if (isInjured) {
      const tag = txt(`[${t('roster.injured').replace('{time}', injuryCountdown(injuredUntil, now))}]`, 10, C.red);
      tag.x = tagX; tag.y = cy + 10; this.bodyLayer.addChild(tag);
    }

    // Troop count (right side)
    if (def && state !== undefined) {
      const cap = troopCap(card);
      const cur = state.currentTroops;
      const troopLbl = txt(`${cur}/${cap}`, 10, cur >= cap ? C.gold : C.mid);
      troopLbl.anchor.set(1, 0); troopLbl.x = w - 18; troopLbl.y = cy + 10;
      this.bodyLayer.addChild(troopLbl);
    }

    // Gear slot indicators (3 dots: filled = has equipment)
    const gearX = w - 18;
    const gearY = cy + 30;
    (['weapon', 'armor', 'trinket'] as EquipSlot[]).forEach((slot, i) => {
      const filled = !!(card.gear[slot]);
      const g = new PIXI.Graphics();
      g.beginFill(filled ? C.accent : 0xddddcc).drawCircle(0, 0, 3).endFill();
      g.x = gearX - (2 - i) * 10; g.y = gearY;
      this.bodyLayer.addChild(g);
    });

    this.hitRects.push({
      rect: { x: 6, y: cy, w: w - 12, h: ROW_H - 4 },
      action: () => this.openDetail(card.id),
    });
  }

  // ── Detail modal ─────────────────────────────────────────────────────────

  private openDetail(cardId: string): void {
    const save = this.cb.getSave();
    const card = save.cardInv?.[cardId];
    if (!card) { this.detailId = null; this.closeModal(); return; }
    this.detailId = cardId;

    const { w, h } = this;
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalHits = [];
    this.modalOpen = true;

    const def = CARD_DEFS[card.defId];
    const cardState = this.cb.getCardState?.();
    const state = cardState?.[card.id];
    const now = Date.now();
    const isInjured = (state?.injuredUntil ?? 0) > now;
    const cap = def ? troopCap(card) : 0;
    const power = Math.round(cardPower(card, save.equipmentInv ?? {}));
    const maxLevel = card.level >= 9;

    // Compute XP progress bar fraction.
    const xpNeeded = maxLevel ? 1 : xpToNextLevel(card.level);
    const xpFrac = maxLevel ? 1 : Math.min(1, card.xp / xpNeeded);

    const mw = Math.min(320, w - 24);
    // Height: title(32) + stats(80) + skill(36) + xp(30) + gearSlots(28) + actions(40) + padding
    const mh = Math.min(430, h - 60);
    const mx = (w - mw) / 2;
    const my = Math.max(HUD_H + 4, (h - mh) / 2);

    // Dim
    const dim = new PIXI.Graphics();
    dim.beginFill(MODAL_DIM, 0.45).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: isInjured ? C.red : C.accent, width: 2, seed: seedFor(0, 5, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    let cy = my + 12;

    // Name + faction
    const factionColor = def?.faction === 'anna' ? 0xcc4466 : 0x4477cc;
    const nameLbl = txt(t(`card.${card.defId}.name` as TranslationKey), 15, C.dark, true);
    nameLbl.x = mx + 12; nameLbl.y = cy;
    ml.addChild(nameLbl);

    const facStr = def ? t(`roster.faction.${def.faction}` as TranslationKey) : '';
    const facLbl = txt(facStr, 10, factionColor);
    facLbl.anchor.set(1, 0); facLbl.x = mx + mw - 12; facLbl.y = cy + 2;
    ml.addChild(facLbl);
    cy += 22;

    const lvLine = txt(`${t('roster.level').replace('{lv}', String(card.level))}   ${t('roster.power')} ${power}`, 12, C.mid);
    lvLine.x = mx + 12; lvLine.y = cy;
    ml.addChild(lvLine);
    cy += 18;

    // Troop cap
    const troopLine = txt(`${t('roster.troopCap')}: ${cap}`, 11, C.dark);
    troopLine.x = mx + 12; troopLine.y = cy;
    ml.addChild(troopLine);
    if (state !== undefined) {
      const troopCurLbl = txt(`${state.currentTroops}/${cap}`, 11, state.currentTroops >= cap ? C.gold : C.dark);
      troopCurLbl.anchor.set(1, 0); troopCurLbl.x = mx + mw - 12; troopCurLbl.y = cy;
      ml.addChild(troopCurLbl);
    }
    cy += 18;

    // Injury status + recover button
    if (isInjured && state?.injuredUntil) {
      const injLine = txt(t('roster.injured').replace('{time}', injuryCountdown(state.injuredUntil, now)), 11, C.red);
      injLine.x = mx + 12; injLine.y = cy;
      ml.addChild(injLine);

      if (this.cb.recoverCard && !this.bt.busy) {
        const recBtnW = 110;
        const recBtn = sketchPanel(recBtnW, 22, { fill: 0xf0e0e0, border: C.red, seed: seedFor(cy, 3, recBtnW) });
        recBtn.x = mx + mw - 12 - recBtnW; recBtn.y = cy - 1;
        ml.addChild(recBtn);
        const recLbl = txt(t('roster.recoverBtn'), 10, C.dark);
        recLbl.anchor.set(0.5, 0.5); recLbl.x = recBtn.x + recBtnW / 2; recLbl.y = recBtn.y + 11;
        ml.addChild(recLbl);
        this.modalHits.push({
          rect: { x: recBtn.x, y: recBtn.y, w: recBtnW, h: 22 },
          action: () => void this.doRecover(card.id),
        });
      }
      cy += 22;
    }
    cy += 4;

    // Skill
    const skillVal = def ? def.skillGrowth[Math.max(0, card.level - 1)] : 0;
    const hasSkill = def?.faction === 'anna' && skillVal > 0;
    const skillKey = hasSkill ? `card.${card.defId}.desc` as TranslationKey : 'roster.skillNone' as TranslationKey;
    const skillLine = txt(`${t('roster.skill')}: ${t(skillKey)}`, 11, hasSkill ? C.accent : C.mid);
    skillLine.x = mx + 12; skillLine.y = cy;
    skillLine.style.wordWrap = true; skillLine.style.wordWrapWidth = mw - 24;
    ml.addChild(skillLine);
    cy += 28;

    // XP progress bar
    const barW = mw - 24;
    const barH = 10;
    const barBg = new PIXI.Graphics();
    barBg.beginFill(0xe0ddd4).drawRoundedRect(mx + 12, cy, barW, barH, 4).endFill();
    ml.addChild(barBg);
    if (!maxLevel && xpFrac > 0) {
      const barFill = new PIXI.Graphics();
      barFill.beginFill(C.accent).drawRoundedRect(mx + 12, cy, Math.max(4, barW * xpFrac), barH, 4).endFill();
      ml.addChild(barFill);
    }
    const xpLbl = maxLevel
      ? txt(t('roster.maxLevel'), 10, C.gold, true)
      : txt(`${card.xp} / ${xpNeeded} XP`, 10, C.mid);
    xpLbl.anchor.set(0.5, 0); xpLbl.x = mx + mw / 2; xpLbl.y = cy + 12;
    ml.addChild(xpLbl);
    cy += 26;

    // Gear slots (3 slots; tap each to open equipment scene)
    this.renderDetailGearSlots(card, mx, cy, mw, save);
    cy += 38;

    // Action buttons
    const btnY = my + mh - 40;
    const btnH = 30;
    const buttons: { label: string; fill: number; stroke: number; fn: () => void; on: boolean }[] = [];

    // Lock / unlock
    const lockOn = !this.bt.busy;
    buttons.push(card.locked
      ? { label: t('roster.unlock'), fill: 0xeeeedd, stroke: C.mid, on: lockOn, fn: () => void this.doSetLock(card.id, false) }
      : { label: t('roster.lock'), fill: 0xeeeedd, stroke: C.mid, on: lockOn, fn: () => void this.doSetLock(card.id, true) });

    // Feed
    const feedOn = !this.bt.busy && !maxLevel;
    buttons.push({ label: t('roster.feedBtn'), fill: C.dark, stroke: C.gold, on: feedOn, fn: () => this.openFeedSelect(card) });

    // Auction (requires all gear slots empty)
    const allGearEmpty = !card.gear.weapon && !card.gear.armor && !card.gear.trinket;
    const auctionOn = !this.bt.busy && !card.locked && allGearEmpty;
    buttons.push({ label: t('roster.listAuction'), fill: 0xf5f0e8, stroke: C.mid, on: auctionOn, fn: () => this.showToast(t('roster.listAuctionNeedUnequip' as TranslationKey), C.mid) });

    const n = buttons.length;
    const gap = 6;
    const bw = (mw - 24 - gap * (n - 1)) / n;
    buttons.forEach((b, i) => {
      const x = mx + 12 + i * (bw + gap);
      const g = sketchPanel(bw, btnH, { fill: b.on ? b.fill : C.btnOff, border: b.on ? b.stroke : C.mid, seed: seedFor(i, 6, bw) });
      g.x = x; g.y = btnY;
      ml.addChild(g);
      const lbl = txt(b.label, 11, b.on ? (b.fill === 0xeeeedd || b.fill === 0xf5f0e8 ? C.dark : C.light) : C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = x + bw / 2; lbl.y = btnY + btnH / 2;
      ml.addChild(lbl);
      if (b.on) this.modalHits.push({ rect: { x, y: btnY, w: bw, h: btnH }, action: b.fn });
    });

    // Tap outside to close
    this.modalHits.push({ rect: { x: mx, y: my, w: mw, h: mh }, action: () => {} });
    this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => this.closeDetail() });
  }

  /** Render 3 gear slot boxes inside the detail modal. */
  private renderDetailGearSlots(card: CardInstance, mx: number, cy: number, mw: number, save: SaveData): void {
    const EQUIP_SLOTS: EquipSlot[] = ['weapon', 'armor', 'trinket'];
    const cellW = (mw - 24 - 8 * 2) / 3;
    const cellH = 34;

    EQUIP_SLOTS.forEach((slot, i) => {
      const x = mx + 12 + i * (cellW + 8);
      const instId = card.gear[slot];
      const inst = instId ? save.equipmentInv?.[instId] : undefined;
      const cell = sketchPanel(cellW, cellH, { fill: 0xf0eeea, border: inst ? C.accent : C.mid, seed: seedFor(i, 8, cellW) });
      cell.x = x; cell.y = cy;
      this.modalLayer.addChild(cell);

      const slotLbl = txt(t(`equip.slot.${slot}` as TranslationKey), 9, inst ? C.mid : C.light);
      slotLbl.anchor.set(0.5, 0.5); slotLbl.x = x + cellW / 2; slotLbl.y = cy + cellH / 2;
      this.modalLayer.addChild(slotLbl);

      if (inst) {
        const nameLbl = txt(`+${inst.level}`, 10, C.dark, true);
        nameLbl.anchor.set(1, 0); nameLbl.x = x + cellW - 4; nameLbl.y = cy + 4;
        this.modalLayer.addChild(nameLbl);
      }

      if (this.cb.openEquipment && !this.bt.busy) {
        this.modalHits.push({
          rect: { x, y: cy, w: cellW, h: cellH },
          action: () => { this.closeModal(); this.cb.openEquipment!(card.id); },
        });
      }
    });
  }

  // ── Feed flow ─────────────────────────────────────────────────────────────

  private openFeedSelect(target: CardInstance): void {
    const save = this.cb.getSave();
    const def = CARD_DEFS[target.defId];
    if (!def) return;

    // Eligible materials: same faction, not locked, not this card, not in SLG team.
    const cardState = this.cb.getCardState?.() ?? {};
    const candidates = Object.values(save.cardInv ?? {}).filter((c) => {
      if (c.id === target.id) return false;
      if (c.locked) return false;
      const matDef = CARD_DEFS[c.defId];
      if (!matDef || matDef.faction !== def.faction) return false;
      if (cardState[c.id]?.teamId) return false; // deployed cards cannot be fed
      return true;
    });

    const { w, h } = this;
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalHits = [];
    this.modalOpen = true;

    const selected = new Set<string>();
    const drawFeedPanel = (): void => {
      ml.removeChildren();
      this.modalHits = [];

      const mw = Math.min(320, w - 24);
      const rowH = 44;
      const mh = Math.min(60 + candidates.length * rowH + 56, h - 60);
      const mx = (w - mw) / 2;
      const my = Math.max(HUD_H + 4, (h - mh) / 2);

      const dim = new PIXI.Graphics();
      dim.beginFill(MODAL_DIM, 0.45).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim);

      const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.gold, width: 2, seed: seedFor(0, 18, mw) });
      panel.x = mx; panel.y = my;
      ml.addChild(panel);

      const titleLbl = txt(t('roster.feedTitle'), 13, C.dark, true);
      titleLbl.anchor.set(0.5, 0); titleLbl.x = mx + mw / 2; titleLbl.y = my + 10;
      ml.addChild(titleLbl);

      const hintLbl = txt(t('roster.feedHint'), 10, C.mid);
      hintLbl.anchor.set(0.5, 0); hintLbl.x = mx + mw / 2; hintLbl.y = my + 26;
      ml.addChild(hintLbl);

      let cy = my + 44;
      if (candidates.length === 0) {
        const empty = txt(t('roster.feedEmpty'), 12, C.mid);
        empty.anchor.set(0.5, 0.5); empty.x = mx + mw / 2; empty.y = my + mh / 2 - 20;
        ml.addChild(empty);
      }

      for (const mat of candidates) {
        const isSelected = selected.has(mat.id);
        const matDef = CARD_DEFS[mat.defId];
        const rowBg = sketchPanel(mw - 16, rowH - 4, { fill: isSelected ? 0xfaf0d4 : 0xf5f3ec, border: isSelected ? C.gold : C.mid, seed: seedFor(cy, 19, mw) });
        rowBg.x = mx + 8; rowBg.y = cy;
        ml.addChild(rowBg);

        const check = txt(isSelected ? '[✓]' : '[ ]', 12, isSelected ? C.accent : C.mid);
        check.x = mx + 14; check.y = cy + 6;
        ml.addChild(check);

        const matName = t(`card.${mat.defId}.name` as TranslationKey);
        const nameLbl = txt(`${matName} Lv.${mat.level}`, 12, C.dark, true);
        nameLbl.x = mx + 36; nameLbl.y = cy + 6;
        ml.addChild(nameLbl);

        const facLbl = txt(matDef ? t(`roster.faction.${matDef.faction}` as TranslationKey) : '', 10, matDef?.faction === 'anna' ? 0xcc4466 : 0x4477cc);
        facLbl.x = mx + 36; facLbl.y = cy + 22;
        ml.addChild(facLbl);

        const matId = mat.id;
        this.modalHits.push({
          rect: { x: mx + 8, y: cy, w: mw - 16, h: rowH - 4 },
          action: () => {
            if (selected.has(matId)) selected.delete(matId);
            else selected.add(matId);
            drawFeedPanel();
          },
        });
        cy += rowH;
      }

      // Confirm button
      const confirmOn = selected.size > 0 && !this.bt.busy;
      const confirmBtnW = 100;
      const confirmBtn = sketchPanel(confirmBtnW, 28, {
        fill: confirmOn ? C.dark : C.btnOff, border: confirmOn ? C.gold : C.mid,
        seed: seedFor(0, 20, confirmBtnW),
      });
      confirmBtn.x = mx + mw / 2 - confirmBtnW - 4; confirmBtn.y = my + mh - 36;
      ml.addChild(confirmBtn);
      const confirmLbl = txt(`${t('roster.feedBtn')} (${selected.size})`, 11, confirmOn ? C.light : C.mid);
      confirmLbl.anchor.set(0.5, 0.5); confirmLbl.x = confirmBtn.x + confirmBtnW / 2; confirmLbl.y = confirmBtn.y + 14;
      ml.addChild(confirmLbl);
      if (confirmOn) {
        this.modalHits.push({
          rect: { x: confirmBtn.x, y: confirmBtn.y, w: confirmBtnW, h: 28 },
          action: () => void this.doFeed(target.id, [...selected]),
        });
      }

      // Cancel button
      const cancelBtnW = 80;
      const cancelBtn = sketchPanel(cancelBtnW, 28, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 21, cancelBtnW) });
      cancelBtn.x = mx + mw / 2 + 4; cancelBtn.y = my + mh - 36;
      ml.addChild(cancelBtn);
      const cancelLbl = txt(t('equip.cancel'), 11, C.dark);
      cancelLbl.anchor.set(0.5, 0.5); cancelLbl.x = cancelBtn.x + cancelBtnW / 2; cancelLbl.y = cancelBtn.y + 14;
      ml.addChild(cancelLbl);
      this.modalHits.push({ rect: { x: cancelBtn.x, y: cancelBtn.y, w: cancelBtnW, h: 28 }, action: () => { this.closeModal(); this.render(); } });

      // Dismiss on backdrop
      this.modalHits.push({ rect: { x: mx, y: my, w: mw, h: mh }, action: () => {} });
      this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => { this.closeModal(); this.render(); } });
    };

    drawFeedPanel();
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private async doFeed(targetId: string, materialIds: string[]): Promise<void> {
    if (this.bt.busy) return;
    this.bt.start();
    this.closeModal();
    this.render();
    try {
      const res = await withTimeout(this.cb.feedCards(targetId, materialIds));
      if (res.ok) {
        this.showToast(t('roster.feedOk'), C.green);
      } else {
        this.showToast(t(res.key), C.red);
      }
    } catch (e) {
      this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'roster.feedErr'), C.red);
    } finally {
      this.bt.stop();
      this.detailId = null;
      this.render();
    }
  }

  private async doSetLock(cardId: string, locked: boolean): Promise<void> {
    if (this.bt.busy) return;
    this.bt.start(); this.render();
    try {
      const res = await withTimeout(this.cb.setCardLock(cardId, locked));
      if (res.ok) this.showToast(locked ? t('roster.lockOk') : t('roster.unlockOk'), C.green);
      else this.showToast(t(res.key), C.red);
    } catch (e) {
      this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'roster.err.generic'), C.red);
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  private async doRecover(cardId: string): Promise<void> {
    if (this.bt.busy || !this.cb.recoverCard) return;
    this.bt.start(); this.render();
    try {
      const res = await withTimeout(this.cb.recoverCard(cardId));
      if (res.ok) this.showToast(t('roster.recoverOk'), C.green);
      else this.showToast(t(res.key), C.red);
    } catch (e) {
      this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'roster.recoverErr'), C.red);
    } finally {
      this.bt.stop();
      this.detailId = null;
      this.render();
    }
  }

  // ── Modal helpers ─────────────────────────────────────────────────────────

  private closeDetail(): void {
    this.detailId = null;
    this.closeModal();
  }

  private closeModal(): void {
    this.modalLayer.removeChildren();
    this.modalHits = [];
    this.modalOpen = false;
  }

  // ── Toast ─────────────────────────────────────────────────────────────────

  private showToast(msg: string, color: number = C.dark): void {
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

  // ── Input / lifecycle ─────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    if (this.modalOpen) {
      for (const { rect, action } of this.modalHits) {
        if (this.inRect(x, y, rect)) { action(); return; }
      }
      return;
    }
    for (const { rect, action } of this.hitRects) {
      if (this.inRect(x, y, rect)) { action(); return; }
    }
    this.dragStart = { x, y, scroll: this.scrollY };
  }

  private handleMove(y: number): void {
    if (!this.dragStart || this.modalOpen) return;
    const dy = y - this.dragStart.y;
    if (Math.abs(dy) > 6) {
      this.scrollY = Math.max(0, this.dragStart.scroll - dy);
      this.render();
    }
  }

  private handleUp(): void {
    this.dragStart = null;
  }

  private inRect(x: number, y: number, r: Rect): boolean {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
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
