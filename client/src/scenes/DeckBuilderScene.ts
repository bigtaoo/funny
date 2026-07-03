// DeckBuilderScene — PvP deck builder (P3, PVP_LOADOUT_DESIGN §8).
//
// Shows all cards a player may include in their PvP deck, grouped by unlock tier.
// Locked cards (ELO gate not reached) are displayed greyed out with a lock badge.
// Player toggles cards to build exactly PVP_DECK_SIZE (10) unique cards, with at
// least 1 building and 1 spell.  Confirm saves the deck and calls onSave(deck).

import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import {
  ui as C, txt, buildPaperBackground, sketchPanel, tearDownChildren,
} from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { buildIcon } from '../render/icons';
import { CARD_DEFINITIONS } from '../game/config';
import {
  PVP_DECK_SIZE,
  PVP_BASE_CARDS,
  PVP_UNLOCK_TIERS,
  getPvpUnlockedCards,
  validatePvpDeckClient,
  defaultPvpDeck,
} from '../game/meta/pvpLoadout';

export interface DeckBuilderCallbacks {
  onSave(deck: string[]): void;
  onBack(): void;
  /** Current saved deck (undefined = use default). */
  getCurrentDeck(): string[] | undefined;
  /** Player's current ELO to compute unlock gates (dropped elo re-locks high-tier units). */
  getCurrentElo(): number;
}

interface Hit { rect: Rect; fn: () => void; }

// All displayable card ids in tier order (base first, then unlock tiers).
const ALL_PVP_CARDS: string[] = [
  ...PVP_BASE_CARDS,
  ...PVP_UNLOCK_TIERS.flatMap((t) => [...t.cards]),
];

function strHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function cardDisplayName(id: string): string {
  const def = CARD_DEFINITIONS.find((c) => c.id === id);
  if (!def) return id;
  return t(def.nameKey as TranslationKey);
}

export class DeckBuilderScene implements Scene {
  readonly container: PIXI.Container;
  private readonly w: number;
  private readonly h: number;
  private readonly cb: DeckBuilderCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

  private selected: Set<string>;
  private errorMsg = '';
  private scrollY = 0;
  private scrollMax = 0;
  private listStartY = 0;
  private listH = 0;
  private dragStartY: number | null = null;
  private dragScrollStart = 0;

  constructor(layout: ILayout, input: InputManager, cb: DeckBuilderCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;

    const saved = cb.getCurrentDeck();
    this.selected = new Set(saved ?? defaultPvpDeck());

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp(() => { this.dragStartY = null; }));

    this.render();
  }

  update(): void { /* static */ }

  destroy(): void { this.unsubs.forEach((u) => u()); }

  private handleDown(x: number, y: number): void {
    // Scroll initiation in the list area
    if (y >= this.listStartY && y <= this.listStartY + this.listH) {
      this.dragStartY = y;
      this.dragScrollStart = this.scrollY;
      return;
    }
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
  }

  private handleMove(x: number, y: number): void {
    if (this.dragStartY === null) return;
    const delta = this.dragStartY - y;
    this.scrollY = Math.max(0, Math.min(this.scrollMax, this.dragScrollStart + delta));
    this.render();
  }

  private toggleCard(id: string): void {
    if (this.selected.has(id)) {
      this.selected.delete(id);
    } else {
      this.selected.add(id);
    }
    this.errorMsg = '';
    this.render();
  }

  private confirm(): void {
    const deck = Array.from(this.selected);
    const err = validatePvpDeckClient(deck, this.cb.getCurrentElo());
    if (err) {
      this.errorMsg = err;
      this.render();
      return;
    }
    this.cb.onSave(deck);
  }

  private render(): void {
    tearDownChildren(this.container);
    this.hits = [];
    const { w, h } = this;
    const pad = Math.round(w * 0.05);

    this.container.addChild(buildPaperBackground('deckbg', w, h));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    const hdr = drawSceneHeader(this.container, w, h, t('pvp.deckBuilder' as TranslationKey));
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });
    const tbH = hdr.headerH;

    const elo = this.cb.getCurrentElo();
    const unlocked = new Set(getPvpUnlockedCards(elo));

    // ── Footer: counter + confirm ────────────────────────────────────────────
    const footerH = Math.round(h * 0.12);
    const footerY = h - footerH;

    // Confirm button
    const btnW = Math.round(w * 0.4);
    const btnH = Math.round(footerH * 0.65);
    const btnX = w - pad - btnW;
    const btnY = footerY + Math.round((footerH - btnH) / 2);
    const btnPanel = sketchPanel(btnW, btnH, { fill: C.accent, border: C.dark, width: 2, seed: strHash('db_confirm') });
    btnPanel.x = btnX; btnPanel.y = btnY;
    this.container.addChild(btnPanel);
    const btnLabel = txt(t('pvp.confirmDeck' as TranslationKey), Math.round(h * 0.028), C.dark);
    btnLabel.anchor.set(0.5, 0.5); btnLabel.x = btnX + btnW / 2; btnLabel.y = btnY + btnH / 2;
    this.container.addChild(btnLabel);
    this.hits.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, fn: () => this.confirm() });

    // Card counter
    const count = this.selected.size;
    const counterLabel = txt(`${count} / ${PVP_DECK_SIZE}`, Math.round(h * 0.032), count === PVP_DECK_SIZE ? C.dark : C.mid);
    counterLabel.anchor.set(0, 0.5); counterLabel.x = pad; counterLabel.y = footerY + footerH / 2;
    this.container.addChild(counterLabel);

    // Error message
    if (this.errorMsg) {
      const errTxt = txt(this.errorMsg, Math.round(h * 0.022), 0xe05555);
      errTxt.anchor.set(0, 1); errTxt.x = pad; errTxt.y = footerY - Math.round(h * 0.01);
      this.container.addChild(errTxt);
    }

    // ── Scrollable card grid ─────────────────────────────────────────────────
    const listY = tbH + Math.round(h * 0.02);
    this.listStartY = listY;
    this.listH = footerY - listY;

    const cols = 2;
    const cardW = Math.round((w - pad * 3) / cols);
    const cardH = Math.round(h * 0.13);
    const gapY = Math.round(h * 0.015);

    const listContainer = new PIXI.Container();
    listContainer.x = 0;
    listContainer.y = listY - this.scrollY;

    let totalH = 0;
    ALL_PVP_CARDS.forEach((id, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const cx = pad + col * (cardW + pad);
      const cy = row * (cardH + gapY);
      totalH = cy + cardH;

      const isUnlocked = unlocked.has(id);
      const isSelected = this.selected.has(id);

      // Card panel
      const panel = sketchPanel(cardW, cardH, {
        fill: isSelected && isUnlocked ? C.accent : C.paper,
        border: isSelected && isUnlocked ? C.dark : C.mid,
        width: isSelected && isUnlocked ? 2 : 1,
        seed: strHash('db_' + id),
      });
      panel.alpha = isUnlocked ? 1 : 0.45;
      panel.x = cx; panel.y = cy;
      listContainer.addChild(panel);

      // Card name
      const name = txt(cardDisplayName(id), Math.round(h * 0.025), isSelected && isUnlocked ? C.paper : C.dark, true);
      name.anchor.set(0.5, 0.5); name.x = cx + cardW / 2; name.y = cy + cardH / 2;
      listContainer.addChild(name);

      // Lock badge for tier-unlock cards that are not yet unlocked
      if (!isUnlocked) {
        const lockSz = Math.round(h * 0.032);
        const lockIcon = buildIcon('lock', lockSz, C.mid);
        lockIcon.x = cx + cardW - Math.round(w * 0.02) - lockSz; lockIcon.y = cy + Math.round(h * 0.01);
        listContainer.addChild(lockIcon);
      }

      // Selected check badge
      if (isSelected && isUnlocked) {
        const check = txt('✓', Math.round(h * 0.03), C.accent);
        check.anchor.set(1, 0); check.x = cx + cardW - Math.round(w * 0.02); check.y = cy + Math.round(h * 0.01);
        listContainer.addChild(check);
      }
    });

    this.scrollMax = Math.max(0, totalH - this.listH + Math.round(h * 0.02));

    // Mask
    const maskGfx = new PIXI.Graphics();
    maskGfx.beginFill(0xffffff).drawRect(0, listY, w, this.listH).endFill();
    this.container.addChild(maskGfx);
    listContainer.mask = maskGfx;
    this.container.addChild(listContainer);

    // Hit rects (absolute coords offset by scroll)
    ALL_PVP_CARDS.forEach((id, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const cx = pad + col * (cardW + pad);
      const cy = row * (cardH + gapY);
      const absY = listY - this.scrollY + cy;
      if (absY + cardH < listY || absY > listY + this.listH) return;
      if (!unlocked.has(id)) return; // locked cards not tappable
      this.hits.push({ rect: { x: cx, y: absY, w: cardW, h: cardH }, fn: () => this.toggleCard(id) });
    });
  }
}
