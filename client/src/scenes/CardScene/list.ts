// Roster list view: the [Cards|Equipment] sidebar rail, the header currency/capacity readout, the
// scrolling icon-card grid, and the per-card cell renderer.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, marginLineX } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { FACTION_COLOR } from '../../render/factionIcon';
import { UNIT_ART_URLS } from '../../render/cardArt';
import { drawHeaderCurrency } from '../../ui/widgets/SceneHeader';
import { drawSidebarTabs, sidebarNavW, type HubTab } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import type { SaveData, CardInstance, EquipSlot } from '../../game/meta/SaveData';
import type { CardSLGState } from '../../net/WorldApiClient';
import { CARD_DEFS, CARD_INV_CAP, CARD_INV_WARN, troopCap, cardPower } from '../../game/meta/cardDefs';
import {
  type Constructor, type CardSceneBaseCtor,
  CARD_CELL_H, CARD_CELL_W_TARGET, sortCards, injuryCountdown,
} from './base';

// Roster grid packs a fixed 5 cards per row (was auto-fit ~6) with roomier gaps than the shared CELL_GAP.
const ROSTER_COLS = 5;
const ROSTER_GAP = 24;

export interface ListHandlers {
  renderSidebar(): void;
  renderHeaderCurrency(): void;
  renderList(): void;
  renderCardCell(card: CardInstance, x: number, y: number, cellW: number, state: CardSLGState | undefined, now: number, save: SaveData): void;
}

export function ListMixin<TBase extends CardSceneBaseCtor>(Base: TBase): TBase & Constructor<ListHandlers> {
  return class extends Base {
    /**
     * Progression group nav [Cards|Equipment?|Skins] (LOBBY_IA_REDESIGN §15): a vertical rail stacked
     * inside the left notebook-margin gutter (`marginLineX`), below the header. Equipment only appears
     * when injected (openEquipmentBag, server-authoritative → online-only); Cards/Skins are always
     * reachable (including offline, reading the local save mirror).
     */
    renderSidebar(): void {
      const sidebarW = sidebarNavW(this.w, this.h, this.landscape);
      const hasEquip = !!this.cb.openEquipmentBag;
      const tabs: HubTab[] = [
        { label: t('roster.title'), active: this.tab === 'list', icon: 'cards' },
        ...(hasEquip ? [{ label: t('equip.title'), active: false, icon: 'armor' as const }] : []),
        { label: t('roster.tab.skins'), active: this.tab === 'skins', icon: 'brush' },
      ];
      const { hits } = drawSidebarTabs(this.bodyLayer, sidebarW, this.headerH, this.h, tabs, (i) => {
        if (i === 0) { this.tab = 'list'; this.render(); return; }
        if (hasEquip && i === 1) { this.cb.openEquipmentBag?.(); return; }
        this.tab = 'skins'; this.render();
      });
      for (const hit of hits) this.hitRects.push({ rect: hit.rect, action: hit.fn });
    }

    /**
     * Coin balance + card-capacity readout drawn into the header row itself (same treatment as
     * EquipmentScene's renderHeaderCurrency), so the currency HUD stays visible and aligned with
     * the title when navigating between the card-inventory/equipment peer scenes instead of popping in/out.
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
        const lbl = txt(t('roster.empty'), FS.heading, C.mid);
        lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + listH / 2;
        lbl.style.wordWrap = true; lbl.style.wordWrapWidth = w - 32;
        this.bodyLayer.addChild(lbl);
        return;
      }

      const sorted = sortCards(cards, save.equipmentInv ?? {});
      // Start the grid right of the sidebar rail (when shown) or the red margin rule; right pad stays one ROSTER_GAP.
      const left = (this.showSidebar ? sidebarNavW(w, h, this.landscape) : marginLineX(w)) + ROSTER_GAP;
      const avail = w - left - ROSTER_GAP;
      // Fixed 5-per-row roster (was auto-fit ~6): wider cards, roomier gaps. Clamp down on narrow viewports.
      const cols = Math.max(1, Math.min(ROSTER_COLS, Math.floor((avail + ROSTER_GAP) / (CARD_CELL_W_TARGET + ROSTER_GAP))));
      const cellW = (avail - ROSTER_GAP * (cols - 1)) / cols;
      const rows = Math.ceil(sorted.length / cols);
      const totalH = rows * (CARD_CELL_H + ROSTER_GAP) + ROSTER_GAP;
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));

      const now = Date.now();
      sorted.forEach((card, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = left + col * (cellW + ROSTER_GAP);
        const y = listY + ROSTER_GAP + row * (CARD_CELL_H + ROSTER_GAP) - this.scrollY;
        if (y + CARD_CELL_H >= listY && y <= listY + listH) {
          this.renderCardCell(card, x, y, cellW, cardState[card.id], now, save);
        }
      });

      drawScrollIndicator(this.bodyLayer, { x: left, y: listY, w: avail, h: listH }, this.scrollY, Math.max(0, totalH - listH));
    }

    /**
     * Icon-card cell: a full-height unit portrait on the left, with every hero detail
     * (name / level / power / troops / status / gear) stacked in a column immediately to
     * its right. Border color encodes SLG state (injured = red, deployed = accent).
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

      // ── Left: full-height portrait in a light frame (portrait spans the whole cell height) ──
      const imgH = CARD_CELL_H - pad * 2;
      const imgW = Math.round(imgH * 0.72); // portrait-tall frame (unit art is taller than wide)
      const imgX = x + pad;
      const imgY = y + pad;
      const frame = sketchPanel(imgW, imgH, { fill: 0xf0eee7, border: C.mid, seed: seedFor(x, y, imgW) });
      frame.x = imgX; frame.y = imgY;
      this.bodyLayer.addChild(frame);
      const artUrl = def ? UNIT_ART_URLS[def.unitType] : undefined;
      if (artUrl) this.drawArtFit(artUrl, imgX + 2, imgY + 2, imgW - 4, this.bodyLayer, imgH - 4);

      // ── Right: info column (name at top, stats stacked below) ──
      const ax = imgX + imgW + 12;
      const rightW = x + cellW - pad - ax; // available text width to the right of the portrait

      // Name row: faction dot + name (name clipped so long names don't overrun the column). The
      // dense roster rows keep a plain colour dot — the full totem (detail modal) is unreadable this
      // small; here colour alone conveys faction. Colour still comes from the one FACTION_COLOR source.
      const dot = new PIXI.Graphics();
      dot.beginFill(FACTION_COLOR[def?.faction ?? 'tao']).drawCircle(0, 0, 5).endFill();
      dot.x = ax + 5; dot.y = y + pad + 7;
      this.bodyLayer.addChild(dot);

      const cardName = t(`card.${card.defId}.name` as TranslationKey);
      const nameLbl = txt(cardName, FS.bodyLg, C.dark, true);
      nameLbl.x = ax + 16; nameLbl.y = y + pad;
      nameLbl.style.wordWrap = false;
      // Leave room for the lock badge on the name row when locked.
      const nameMaxW = rightW - 16 - (card.locked ? 24 : 0);
      if (nameLbl.width > nameMaxW) nameLbl.scale.set(Math.min(1, nameMaxW / nameLbl.width));
      this.bodyLayer.addChild(nameLbl);

      // Lock badge (top-right of the info column).
      if (card.locked) {
        const lk = buildIcon('lock', 18, C.mid);
        lk.x = x + cellW - pad - 18; lk.y = y + pad;
        this.bodyLayer.addChild(lk);
      }

      let ay = y + pad + 34;
      // Level as a row of gold stars, not a small "Lv.N" — level is the headline stat and a lone
      // number was too easy to overlook. One filled star per level (max 9); the row shrinks to fit
      // the info column so high-level cards still stay on one line.
      const stars = new PIXI.Container();
      stars.name = 'levelStars'; // test hook: one child per level star (see cardSceneLevelStars.ui.ts)
      const starN = Math.max(1, Math.min(9, card.level));
      const starSize = 15;
      const starGap = 3;
      for (let i = 0; i < starN; i++) {
        const st = buildIcon('star', starSize, C.gold);
        st.x = i * (starSize + starGap);
        stars.addChild(st);
      }
      const starsW = starN * starSize + (starN - 1) * starGap;
      if (starsW > rightW) stars.scale.set(rightW / starsW);
      stars.x = ax; stars.y = ay;
      this.bodyLayer.addChild(stars);
      ay += 24;

      const power = Math.round(cardPower(card, save.equipmentInv ?? {}));
      const pwrLbl = txt(`${t('roster.power')} ${power}`, FS.small, C.dark);
      pwrLbl.x = ax; pwrLbl.y = ay; this.bodyLayer.addChild(pwrLbl);
      ay += 24;

      if (def && state !== undefined) {
        const cap = troopCap(card);
        const cur = state.currentTroops;
        const troopLbl = txt(`${cur}/${cap}`, FS.small, cur >= cap ? C.gold : C.mid);
        troopLbl.x = ax; troopLbl.y = ay; this.bodyLayer.addChild(troopLbl);
        ay += 24;
      }

      // Status tag (deployed / injured).
      if (inTeam) {
        const tag = txt(`[${t('roster.inTeam')}]`, FS.tiny, C.accent, true);
        tag.x = ax; tag.y = ay; this.bodyLayer.addChild(tag); ay += 20;
      } else if (isInjured) {
        const tag = txt(`[${t('roster.injured').replace('{time}', injuryCountdown(injuredUntil, now))}]`, FS.tiny, C.red);
        tag.x = ax; tag.y = ay; this.bodyLayer.addChild(tag); ay += 20;
      }

      // Gear slot indicators (3 dots: filled = has equipment) — bottom-right of the info column.
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
