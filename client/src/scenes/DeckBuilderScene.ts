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
import { drawScrollIndicator } from '../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../ui/widgets/scrollPeek';
import { buildIcon } from '../render/icons';
import { FS } from '../render/fontScale';
import { ScrollTapGesture } from '../ui/scrollTapGesture';
import { wheelScrollY } from '../ui/wheelScroll';
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
  /** Set in destroy(); guards render() against any late re-render into a torn-down container. */
  private destroyed = false;

  private selected: Set<string>;
  private errorMsg = '';
  private scrollY = 0;
  private scrollMax = 0;
  private listStartY = 0;
  private listH = 0;
  /**
   * Tap-vs-drag gesture tracker: defers a card cell's toggle to pointer-up and drops it if the pointer
   * dragged. The old code returned early for any press in the list area (so a card tap was swallowed
   * entirely and only scroll worked); this restores tap-to-toggle while keeping drag-to-scroll. See ScrollTapGesture.
   */
  private readonly gesture = new ScrollTapGesture();
  /** Set by handleMove instead of rendering inline — see EquipmentSceneBase.scrollDirty for why. */
  private scrollDirty = false;

  constructor(layout: ILayout, input: InputManager, cb: DeckBuilderCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;

    const saved = cb.getCurrentDeck();
    this.selected = new Set(saved ?? defaultPvpDeck());

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
    this.unsubs.push(input.onWheel((_x, y, deltaY) => this.handleWheel(y, deltaY)));

    this.render();
  }

  update(): void {
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    this.container.destroy({ children: true });
  }

  private handleDown(x: number, y: number): void {
    // Defer the hit action to pointer-up — if the pointer drags past the threshold it becomes a
    // scroll and the tap is dropped, so a drag starting on a card cell scrolls the grid instead of
    // toggling that card (and a genuine tap still toggles it, unlike the old list-area early-return).
    let hit: (() => void) | null = null;
    for (const h of this.hits) {
      const r = h.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit = h.fn; break; }
    }
    this.gesture.down(this.scrollY, y, hit);
  }

  private handleMove(_x: number, y: number): void {
    const scroll = this.gesture.move(y);
    if (scroll !== null) { this.scrollY = Math.min(this.scrollMax, scroll); this.scrollDirty = true; }
  }

  private handleUp(): void {
    // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
    this.gesture.up()?.();
  }

  /** Mouse-wheel scroll over the card grid (browser/PC only — see wheelScroll.ts). */
  private handleWheel(y: number, deltaY: number): void {
    const next = wheelScrollY(this.listStartY, this.listStartY + this.listH, y, deltaY, this.scrollY, this.scrollMax);
    if (next !== null) { this.scrollY = next; this.scrollDirty = true; }
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
    if (this.destroyed) return;
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
    const btnLabel = txt(t('pvp.confirmDeck' as TranslationKey), FS.title, C.dark);
    btnLabel.anchor.set(0.5, 0.5); btnLabel.x = btnX + btnW / 2; btnLabel.y = btnY + btnH / 2;
    this.container.addChild(btnLabel);
    this.hits.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, fn: () => this.confirm() });

    // Card counter
    const count = this.selected.size;
    const counterLabel = txt(`${count} / ${PVP_DECK_SIZE}`, FS.title, count === PVP_DECK_SIZE ? C.dark : C.mid);
    counterLabel.anchor.set(0, 0.5); counterLabel.x = pad; counterLabel.y = footerY + footerH / 2;
    this.container.addChild(counterLabel);

    // Error message
    if (this.errorMsg) {
      const errTxt = txt(this.errorMsg, FS.label, 0xe05555);
      errTxt.anchor.set(0, 1); errTxt.x = pad; errTxt.y = footerY - Math.round(h * 0.01);
      this.container.addChild(errTxt);
    }

    // ── Scrollable card grid ─────────────────────────────────────────────────
    const listY = tbH + Math.round(h * 0.02);
    this.listStartY = listY;
    const availH = footerY - listY;

    const cols = 2;
    const cardW = Math.round((w - pad * 3) / cols);
    const cardH = Math.round(h * 0.13);
    const gapY = Math.round(h * 0.015);

    // Peek-adjust the viewport so, when the grid overflows, the cut always lands mid-row and a
    // partial next card is visible above the fold (not just the thin ScrollIndicator thumb).
    const rows = Math.ceil(ALL_PVP_CARDS.length / cols);
    const totalH = rows > 0 ? (rows - 1) * (cardH + gapY) + cardH : 0;
    this.listH = peekViewportH(availH, cardH + gapY, totalH);

    const listContainer = new PIXI.Container();
    listContainer.x = 0;
    listContainer.y = listY - this.scrollY;

    ALL_PVP_CARDS.forEach((id, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const cx = pad + col * (cardW + pad);
      const cy = row * (cardH + gapY);

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
      const name = txt(cardDisplayName(id), FS.heading, isSelected && isUnlocked ? C.paper : C.dark, true);
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
        const checkSz = Math.round(h * 0.03);
        const check = buildIcon('check', checkSz, C.accent);
        check.x = cx + cardW - Math.round(w * 0.02) - checkSz; check.y = cy + Math.round(h * 0.01);
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

    drawScrollIndicator(this.container, { x: pad, y: listY, w: w - pad * 2, h: this.listH }, this.scrollY, this.scrollMax);
  }
}
