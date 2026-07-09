// Roster list view: the [Cards|Equipment] sidebar rail, the header currency/capacity readout, the
// scrolling icon-card grid, and the per-card cell renderer.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, marginLineX } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { UNIT_ART_URLS } from '../../render/cardArt';
import { drawHeaderCurrency } from '../../ui/widgets/SceneHeader';
import { drawSidebarTabs, type HubTab } from '../../ui/widgets/HubTabs';
import type { SaveData, CardInstance, EquipSlot } from '../../game/meta/SaveData';
import type { CardSLGState } from '../../net/WorldApiClient';
import { CARD_DEFS, CARD_INV_CAP, CARD_INV_WARN, troopCap, cardPower } from '../../game/meta/cardDefs';
import {
  type Constructor, type CardSceneBaseCtor,
  CELL_GAP, CARD_CELL_H, CARD_CELL_W_TARGET, sortCards, injuryCountdown,
} from './base';

export interface ListHandlers {
  renderSidebar(): void;
  renderHeaderCurrency(): void;
  renderList(): void;
  renderCardCell(card: CardInstance, x: number, y: number, cellW: number, state: CardSLGState | undefined, now: number, save: SaveData): void;
}

export function ListMixin<TBase extends CardSceneBaseCtor>(Base: TBase): TBase & Constructor<ListHandlers> {
  return class extends Base {
    /**
     * Progression group nav [Cards|Equipment] (LOBBY_IA_REDESIGN): a vertical rail stacked inside
     * the left notebook-margin gutter (`marginLineX`), below the header. Cards is active; tapping
     * Equipment opens the equipment bag (openEquipmentBag). Drawn only when injected (showSidebar).
     */
    renderSidebar(): void {
      if (!this.showSidebar) return;
      const sidebarW = marginLineX(this.w);
      const tabs: HubTab[] = [
        { label: t('roster.title'), active: true, icon: 'cards' },
        { label: t('equip.title'), active: false, icon: 'armor' },
      ];
      const { hits } = drawSidebarTabs(this.bodyLayer, sidebarW, this.headerH, this.h, tabs, (i) => {
        if (i === 1) this.cb.openEquipmentBag?.();
      });
      for (const hit of hits) this.hitRects.push({ rect: hit.rect, action: hit.fn });
    }

    /**
     * Coin balance + card-capacity readout drawn into the header row itself (same treatment as
     * EquipmentScene's renderHeaderCurrency), so the currency HUD stays visible and aligned with
     * the title when navigating between the 卡背包/装备 peer scenes instead of popping in/out.
     */
    renderHeaderCurrency(): void {
      this.headerOverlayLayer.removeChildren();
      const save = this.cb.getSave();
      const count = Object.keys(save.cardInv ?? {}).length;
      const warn = count >= CARD_INV_WARN;
      const full = count >= CARD_INV_CAP;
      // Keep the coin + capacity readout at a compact absolute size (matches EquipmentScene, its
      // [Cards|Equipment] peer) rather than scaling it up with the taller unified header.
      drawHeaderCurrency(this.headerOverlayLayer, this.w, this.headerH, save.wallet.coins, [], {
        text: `${t('roster.capacity').replace('{cur}', String(count)).replace('{cap}', String(CARD_INV_CAP))}`,
        color: full ? C.red : warn ? C.gold : C.mid,
      }, 100 / this.headerH);
    }

    renderList(): void {
      const { w, h } = this;
      const save = this.cb.getSave();
      const cardState = this.cb.getCardState?.() ?? {};
      const cards = Object.values(save.cardInv ?? {});
      const listY = this.headerH;
      const listH = h - listY - 8;

      if (cards.length === 0) {
        const lbl = txt(t('roster.empty'), 12, C.mid);
        lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + listH / 2;
        lbl.style.wordWrap = true; lbl.style.wordWrapWidth = w - 32;
        this.bodyLayer.addChild(lbl);
        return;
      }

      const sorted = sortCards(cards, save.equipmentInv ?? {});
      // Start the grid right of the red margin rule; right pad stays one CELL_GAP.
      const left = marginLineX(w) + CELL_GAP;
      const avail = w - left - CELL_GAP;
      const cols = Math.max(1, Math.floor((avail + CELL_GAP) / (CARD_CELL_W_TARGET + CELL_GAP)));
      const cellW = (avail - CELL_GAP * (cols - 1)) / cols;
      const rows = Math.ceil(sorted.length / cols);
      const totalH = rows * (CARD_CELL_H + CELL_GAP) + CELL_GAP;
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));

      const now = Date.now();
      sorted.forEach((card, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = left + col * (cellW + CELL_GAP);
        const y = listY + CELL_GAP + row * (CARD_CELL_H + CELL_GAP) - this.scrollY;
        if (y + CARD_CELL_H >= listY && y <= listY + listH) {
          this.renderCardCell(card, x, y, cellW, cardState[card.id], now, save);
        }
      });
    }

    /**
     * Icon-card cell: name across the top, unit portrait on the left, stats
     * (level / power / troops / gear) on the right. Border color encodes SLG
     * state (injured = red, deployed = accent).
     */
    renderCardCell(
      card: CardInstance,
      x: number,
      y: number,
      cellW: number,
      state: CardSLGState | undefined,
      now: number,
      save: SaveData,
    ): void {
      const def = CARD_DEFS[card.defId];
      const injuredUntil = state?.injuredUntil ?? 0;
      const isInjured = injuredUntil > now;
      const inTeam = !!state?.teamId;
      const pad = 10;

      const border = isInjured ? C.red : (inTeam ? C.accent : C.mid);
      const cell = sketchPanel(cellW, CARD_CELL_H, { fill: 0xfaf9f5, border, seed: seedFor(x, y, cellW) });
      cell.x = x; cell.y = y;
      this.bodyLayer.addChild(cell);

      // ── Top: faction dot + name (name clipped so long names don't overrun) ──
      const factionColor = def?.faction === 'anna' ? 0xcc4466 : 0x4477cc;
      const dot = new PIXI.Graphics();
      dot.beginFill(factionColor).drawCircle(0, 0, 5).endFill();
      dot.x = x + pad + 5; dot.y = y + pad + 7;
      this.bodyLayer.addChild(dot);

      const cardName = t(`card.${card.defId}.name` as TranslationKey);
      const nameLbl = txt(cardName, 14, C.dark, true);
      nameLbl.x = x + pad + 16; nameLbl.y = y + pad;
      nameLbl.style.wordWrap = false;
      if (nameLbl.width > cellW - pad * 2 - 20) {
        const s = cellW / (nameLbl.width + 40);
        nameLbl.scale.set(Math.min(1, s));
      }
      this.bodyLayer.addChild(nameLbl);

      // Lock badge (top-right).
      if (card.locked) {
        const lk = buildIcon('lock', 15, C.mid);
        lk.x = x + cellW - pad - 15; lk.y = y + pad;
        this.bodyLayer.addChild(lk);
      }

      // ── Left: portrait in a light frame ──
      const imgBox = CARD_CELL_H - (pad + 28) - pad; // square
      const imgX = x + pad;
      const imgY = y + pad + 28;
      const frame = sketchPanel(imgBox, imgBox, { fill: 0xf0eee7, border: C.mid, seed: seedFor(x, y, imgBox) });
      frame.x = imgX; frame.y = imgY;
      this.bodyLayer.addChild(frame);
      const artUrl = def ? UNIT_ART_URLS[def.unitType] : undefined;
      if (artUrl) this.drawArtFit(artUrl, imgX + 2, imgY + 2, imgBox - 4);

      // ── Right: stats column ──
      const ax = imgX + imgBox + 12;
      let ay = imgY;
      const lvLbl = txt(`Lv.${card.level}`, 12, C.mid, true);
      lvLbl.x = ax; lvLbl.y = ay; this.bodyLayer.addChild(lvLbl);
      ay += 19;

      const power = Math.round(cardPower(card, save.equipmentInv ?? {}));
      const pwrLbl = txt(`${t('roster.power')} ${power}`, 12, C.dark);
      pwrLbl.x = ax; pwrLbl.y = ay; this.bodyLayer.addChild(pwrLbl);
      ay += 19;

      if (def && state !== undefined) {
        const cap = troopCap(card);
        const cur = state.currentTroops;
        const troopLbl = txt(`${cur}/${cap}`, 12, cur >= cap ? C.gold : C.mid);
        troopLbl.x = ax; troopLbl.y = ay; this.bodyLayer.addChild(troopLbl);
        ay += 19;
      }

      // Status tag (deployed / injured).
      if (inTeam) {
        const tag = txt(`[${t('roster.inTeam')}]`, 10, C.accent, true);
        tag.x = ax; tag.y = ay; this.bodyLayer.addChild(tag); ay += 16;
      } else if (isInjured) {
        const tag = txt(`[${t('roster.injured').replace('{time}', injuryCountdown(injuredUntil, now))}]`, 10, C.red);
        tag.x = ax; tag.y = ay; this.bodyLayer.addChild(tag); ay += 16;
      }

      // Gear slot indicators (3 dots: filled = has equipment) — bottom-right.
      const gearY = y + CARD_CELL_H - pad - 4;
      (['weapon', 'armor', 'trinket'] as EquipSlot[]).forEach((slot, i) => {
        const filled = !!(card.gear[slot]);
        const g = new PIXI.Graphics();
        g.beginFill(filled ? C.accent : 0xddddcc).drawCircle(0, 0, 4).endFill();
        g.x = x + cellW - pad - (2 - i) * 12; g.y = gearY;
        this.bodyLayer.addChild(g);
      });

      this.hitRects.push({
        rect: { x, y, w: cellW, h: CARD_CELL_H },
        action: () => this.openDetail(card.id),
      });
    }
  };
}
