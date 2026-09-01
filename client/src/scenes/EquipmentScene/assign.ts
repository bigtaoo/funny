// Bag "assign to card" sub-mode. Reached only in bag mode (roster group): tapping Equip on a bag
// item opens a full-view card picker (reusing the main drag-scroll), and choosing a card equips
// the item onto that card.
//
// Depends only on EquipmentSceneCore directly. doEquipTo hands off to detail.ts's doEquip through
// the lazy `core.doEquipHook` (default no-op, overwritten by the outer assembly right after
// constructing DetailPanel) rather than a direct reference — AssignPanel is constructed BEFORE
// DetailPanel (DetailPanel needs `this` for beginAssign/ownerCardId), so a direct reference the
// other way isn't available yet at construction time. See core.ts's file-header comment.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { buildLevelStars } from '../../render/levelStars';
import { FACTION_COLOR } from '../../render/factionIcon';
import { cardInstanceArtUrl, getArtTexture } from '../../render/cardArt';
import { sidebarNavW, bottomNavH } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import type { SaveData, EquipSlot, CardInstance } from '../../game/meta/SaveData';
import { CARD_DEFS, MAX_CARD_LEVEL, cardPower } from '../../game/meta/cardDefs';
import { RES_H, SLOTS } from './layout';
import { itemLabel } from './helpers';
import type { EquipmentSceneCore } from './core';

// Card-picker grid: icon cards mirroring the Hero Roster (CardScene/list.ts) so the assign flow reads
// with the same visual language — full-height portrait + name/stars/power stacked to its right, plus
// an assign-specific slot-occupant hint (Slot free / Now: <item>) along the bottom.
const PICK_CELL_H = 266;      // matches CARD_CELL_H (roster hero cards)
const PICK_CELL_W_TARGET = 300;
const PICK_COLS = 5;
const PICK_GAP = 24;

export class AssignPanel {
  private readonly assignArtHooked = new Set<string>();

  constructor(private readonly core: EquipmentSceneCore) {}

  /** Find the card currently wearing `instId` in any slot (bag-mode unequip needs the owner). */
  ownerCardId(save: SaveData, instId: string): string | null {
    for (const card of Object.values(save.cardInv ?? {})) {
      for (const slot of SLOTS) if (card.gear[slot] === instId) return card.id;
    }
    return null;
  }

  beginAssign(instId: string, slot: EquipSlot): void {
    const core = this.core;
    core.assign = { instId, slot };
    core.detailId = null;
    core.closeModal();
    core.scrollY = 0;
    core.render();
  }

  cancelAssign(): void {
    const core = this.core;
    core.assign = null;
    core.scrollY = 0;
    core.render();
  }

  private async doEquipTo(cardId: string): Promise<void> {
    const core = this.core;
    if (!core.assign || core.bt.busy) return;
    const { instId, slot } = core.assign;
    core.assign = null;
    core.scrollY = 0;
    await core.doEquipHook(slot, instId, cardId);
  }

  /** Full-view card picker shown while assigning a bag item to a card (reuses the main scrollY). */
  renderAssign(save: SaveData): void {
    const core = this.core;
    const { w, h } = core;
    if (!core.assign) return;
    const inst = save.equipmentInv[core.assign.instId];
    if (!inst) { core.assign = null; core.render(); return; }
    const slot = core.assign.slot;

    // Landscape: the sidebar rail persists to the left (InventoryPanel.renderSidebar draws it before
    // this sub-mode's body), so the title bar/grid start clear of it. Portrait's peer-level nav is
    // a bottom bar instead (§18) — no width reservation, but availH reserves bottomNavH off the
    // bottom when that bar is actually shown (same hasGroupNav gate as Inventory/Craft).
    const sidebarW = core.landscape ? sidebarNavW(w, h, true) : 0;
    const top = core.headerH;
    const barBg = new PIXI.Graphics();
    barBg.beginFill(0xf3f1ea).drawRect(sidebarW, top, w - sidebarW, RES_H).endFill();
    core.bodyLayer.addChild(barBg);
    const title = txt(t('equip.assignTitle').replace('{name}', itemLabel(inst.defId, inst.level)), FS.label, C.dark, true);
    title.anchor.set(0.5, 0.5); title.x = sidebarW + (w - sidebarW) / 2; title.y = top + RES_H / 2;
    core.bodyLayer.addChild(title);

    const listY = top + RES_H;
    const availH = h - listY - 8 - (!core.landscape && core.hasGroupNav ? bottomNavH(h) : 0);
    const cards = Object.values(save.cardInv ?? {});
    if (cards.length === 0) {
      const lbl = txt(t('equip.assignEmpty'), FS.heading, C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = sidebarW + (w - sidebarW) / 2; lbl.y = listY + availH / 2;
      core.bodyLayer.addChild(lbl);
      core.maxScroll = 0;
      return;
    }

    const equipInv = save.equipmentInv ?? {};
    const sorted = [...cards].sort((a, b) => {
      const pd = cardPower(b, equipInv) - cardPower(a, equipInv);
      if (pd !== 0) return pd;
      if (b.level !== a.level) return b.level - a.level;
      return a.id < b.id ? -1 : 1;
    });

    // Icon-card grid, packed like the Hero Roster: fixed PICK_COLS per row (clamped on narrow
    // viewports), roomier gaps, portrait-tall cells.
    const left = sidebarW + PICK_GAP;
    const avail = w - left - PICK_GAP;
    const cols = Math.max(1, Math.min(PICK_COLS, Math.floor((avail + PICK_GAP) / (PICK_CELL_W_TARGET + PICK_GAP))));
    const cellW = (avail - PICK_GAP * (cols - 1)) / cols;
    const rows = Math.ceil(sorted.length / cols);
    const totalH = rows * (PICK_CELL_H + PICK_GAP) + PICK_GAP;
    // Clamp the viewport so it always cuts mid-row when there's more below (see inventory.ts).
    const listH = peekViewportH(availH, PICK_CELL_H + PICK_GAP, totalH);
    const maxScroll = Math.max(0, totalH - listH);
    core.scrollY = Math.max(0, Math.min(core.scrollY, maxScroll));
    core.scrollRegionTop = listY;
    core.scrollRegionBottom = listY + listH;
    core.maxScroll = maxScroll;

    sorted.forEach((card, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = left + col * (cellW + PICK_GAP);
      const y = listY + PICK_GAP + row * (PICK_CELL_H + PICK_GAP) - core.scrollY;
      if (y + PICK_CELL_H >= listY && y <= listY + listH) this.renderAssignCell(card, x, y, cellW, slot, save);
    });

    drawScrollIndicator(core.bodyLayer, { x: left, y: listY, w: avail, h: listH }, core.scrollY, Math.max(0, totalH - listH));
  }

  /**
   * Assign-picker card cell: mirrors the Hero Roster cell (full-height portrait + name/level-stars/
   * power stacked to its right) and adds an assign-specific slot-occupant hint along the bottom so
   * the player knows whether equipping here fills a free slot or swaps out the current piece.
   */
  private renderAssignCell(card: CardInstance, x: number, y: number, cellW: number, slot: EquipSlot, save: SaveData): void {
    const core = this.core;
    const def = CARD_DEFS[card.defId];
    const pad = 10;

    const cell = sketchPanel(cellW, PICK_CELL_H, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(x, y, cellW) });
    cell.x = x; cell.y = y;
    core.bodyLayer.addChild(cell);

    // ── Left: full-height portrait in a light frame ──
    const imgH = PICK_CELL_H - pad * 2;
    const imgW = Math.round(imgH * 0.72);
    const imgX = x + pad;
    const imgY = y + pad;
    // fillAlpha: 0 — see CardScene/list.ts's renderCardCell (2026-08-21): the cell behind is already
    // the one background layer, this frame is a stroke-only outline.
    const frame = sketchPanel(imgW, imgH, { fill: 0xf0eee7, fillAlpha: 0, border: C.mid, seed: seedFor(x, y, imgW) });
    frame.x = imgX; frame.y = imgY;
    core.bodyLayer.addChild(frame);
    const artUrl = cardInstanceArtUrl(card) ?? undefined;
    if (artUrl) this.drawCardArt(artUrl, imgX + 2, imgY + 2, imgW - 4, imgH - 4);

    // ── Right: info column ──
    const ax = imgX + imgW + 12;
    const rightW = x + cellW - pad - ax;

    const dot = new PIXI.Graphics();
    dot.beginFill(FACTION_COLOR[def?.faction ?? 'tao']).drawCircle(0, 0, 5).endFill();
    dot.x = ax + 5; dot.y = y + pad + 7;
    core.bodyLayer.addChild(dot);

    const nameLbl = txt(t(`card.${card.defId}.name` as TranslationKey), FS.bodyLg, C.dark, true);
    nameLbl.x = ax + 16; nameLbl.y = y + pad;
    nameLbl.style.wordWrap = false;
    if (nameLbl.width > rightW - 16) nameLbl.scale.set(Math.min(1, (rightW - 16) / nameLbl.width));
    core.bodyLayer.addChild(nameLbl);

    let ay = y + pad + 34;
    // Level as a row of gold stars (one filled star per level, max MAX_CARD_LEVEL), shrunk to fit the column.
    const starN = Math.max(1, Math.min(MAX_CARD_LEVEL, card.level));
    const { container: stars } = buildLevelStars(starN, rightW, 15, 3);
    stars.x = ax; stars.y = ay;
    core.bodyLayer.addChild(stars);
    ay += 24;

    const power = Math.round(cardPower(card, save.equipmentInv ?? {}));
    const pwrLbl = txt(`${t('roster.power')} ${power}`, FS.small, C.dark);
    pwrLbl.x = ax; pwrLbl.y = ay; core.bodyLayer.addChild(pwrLbl);

    // ── Bottom: slot-occupant hint (Slot free / Now: <item>), with the current item's icon ──
    const curId = card.gear[slot];
    const cur = curId ? save.equipmentInv[curId] : undefined;
    const hintY = y + PICK_CELL_H - pad - 20;
    let hintX = ax;
    let hintW = rightW;
    if (cur) {
      const iconSize = 22;
      core.addGlyph(slot, cur.rarity, ax + iconSize / 2, hintY + FS.tiny / 2, iconSize, seedFor(x, y, cellW), 1, cur.defId);
      hintX = ax + iconSize + 6;
      hintW = rightW - iconSize - 6;
    }
    const hint = txt(
      cur ? t('equip.assignCurrent').replace('{name}', itemLabel(cur.defId, cur.level)) : t('equip.assignSlotFree'),
      FS.tiny, cur ? C.gold : C.mid,
    );
    hint.x = hintX; hint.y = hintY;
    hint.style.wordWrap = true; hint.style.wordWrapWidth = hintW;
    core.bodyLayer.addChild(hint);

    const cardId = card.id;
    core.hitRects.push({ rect: { x, y, w: cellW, h: PICK_CELL_H }, fn: () => void this.doEquipTo(cardId) });
  }

  /** Draw a unit portrait fitted into (x, y, box × boxH); re-renders once the texture finishes loading. */
  private drawCardArt(url: string, x: number, y: number, box: number, boxH: number): void {
    const core = this.core;
    const tex = getArtTexture(url);
    if (!tex.baseTexture.valid) {
      if (!this.assignArtHooked.has(url)) {
        this.assignArtHooked.add(url);
        tex.baseTexture.once('loaded', () => core.render());
      }
      return;
    }
    const scale = Math.min(box / tex.width, boxH / tex.height);
    const sp = new PIXI.Sprite(tex);
    sp.anchor.set(0.5);
    sp.scale.set(scale);
    sp.position.set(x + box / 2, y + boxH / 2);
    core.bodyLayer.addChild(sp);
  }
}
