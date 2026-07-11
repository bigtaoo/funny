// Unified item picker (scene-level overlay): choosing what to list, reached from the create form's item
// field. Lists every sellable item across all three classes (materials + equipment + cards) in one scrollable
// list, sorted by estimated value descending. Picking an entry returns to the create form.
import { AUCTION_STATIC_REF_PRICE } from '@nw/shared';
import { ui as C, txt, sketchPanel, seedFor, marginLineX } from '../../render/sketchUi';
import { drawSidebarTabs, type HubTab } from '../../ui/widgets/HubTabs';
import { t } from '../../i18n';
import { buildIcon, type IconKind } from '../../render/icons';
import type { EquipmentInstance, CardInstance, EquipRarity } from '../../game/meta/SaveData';
import { FILTERS, type AucFilter, MATERIALS, type Constructor, type AuctionSceneBaseCtor } from './base';

// Icon-card grid metrics (mirrors EquipmentScene/inventory.ts's responsive column layout), enlarged 1.5x
// so glyph/name/hint read clearly now that the grid shares the row with the left category rail.
const CARD_GAP = 15;
const CARD_W_TARGET = 195;
const CARD_H = 156;

// Client tsconfig maps @nw/shared → server/shared/src/slg/index.ts only, so the server's per-rarity/per-card
// auction reference prices (equipment.ts, not under slg/) aren't reachable here. These mirror the server's
// EQUIP_AUCTION_REF_PRICE_BY_RARITY values for sort-order purposes only — not a suggested listing price.
const EQUIP_VALUE_BY_RARITY: Record<EquipRarity, number> = { common: 50, fine: 150, rare: 400, epic: 1200 };
// Cards have no server reference price at all — this is a level-based sort heuristic only.
const CARD_VALUE_BASE = 500;
const CARD_VALUE_PER_LEVEL = 300;

interface PickEntry {
  icon: IconKind;
  label: string;
  value: number;
  locked: boolean;
  cls: 'material' | 'equipment' | 'card';
  onPick: () => void;
}

export interface PickerHandlers {
  renderItemPicker(): void;
  listableEquipment(): EquipmentInstance[];
  listableCards(): CardInstance[];
  selectedItemLabel(): string | null;
  openItemPicker(): void;
  cancelItemPicker(): void;
}

export function PickerMixin<TBase extends AuctionSceneBaseCtor>(Base: TBase): TBase & Constructor<PickerHandlers> {
  return class extends Base {
    /** Equipment instances eligible for listing: not locked and not equipped by any card (mirrors server escrow guard). */
    listableEquipment(): EquipmentInstance[] {
      const save = this.cb.getSave?.();
      if (!save) return [];
      const equippedIds = new Set<string>();
      for (const card of Object.values(save.cardInv ?? {})) {
        for (const id of Object.values(card.gear ?? {})) if (id) equippedIds.add(id);
      }
      return Object.values(save.equipmentInv ?? {}).filter((e) => !e.locked && !equippedIds.has(e.id));
    }

    /** Card instances eligible for listing: gear must be empty before listing (mirrors server escrow guard, §11). */
    listableCards(): CardInstance[] {
      const save = this.cb.getSave?.();
      if (!save) return [];
      return Object.values(save.cardInv ?? {}).filter((c) => !Object.values(c.gear ?? {}).some((v) => !!v));
    }

    /** Label of the currently selected item (any class) for the create form, or null when none is chosen (or it is no longer listable). */
    selectedItemLabel(): string | null {
      if (this.createClass === 'material') {
        return t(`auction.${this.createMaterial}` as 'auction.scrap' | 'auction.lead' | 'auction.binding');
      }
      if (this.createClass === 'equipment') {
        const inst = this.listableEquipment().find((e) => e.id === this.createEquipId);
        return inst ? `${this.equipName(inst.defId)} +${inst.level}` : null;
      }
      const inst = this.listableCards().find((c) => c.id === this.createCardId);
      return inst ? `${this.cardName(inst.defId)} Lv.${inst.level}` : null;
    }

    /** Combined pick list across all three classes, sorted by estimated value descending. */
    private buildPickEntries(): PickEntry[] {
      const entries: PickEntry[] = [];
      for (const mat of MATERIALS) {
        entries.push({
          icon: mat, label: t(`auction.${mat}` as 'auction.scrap' | 'auction.lead' | 'auction.binding'),
          value: AUCTION_STATIC_REF_PRICE[mat] ?? 0, locked: false, cls: 'material',
          onPick: () => { this.createClass = 'material'; this.createMaterial = mat; this.closeItemPicker(); },
        });
      }
      for (const e of this.listableEquipment()) {
        entries.push({
          icon: 'armor', label: `${this.equipName(e.defId)} +${e.level}`,
          value: EQUIP_VALUE_BY_RARITY[e.rarity] ?? 0, locked: false, cls: 'equipment',
          onPick: () => { this.createClass = 'equipment'; this.createEquipId = e.id; this.closeItemPicker(); },
        });
      }
      for (const c of this.listableCards()) {
        entries.push({
          icon: 'cards', label: `${this.cardName(c.defId)} Lv.${c.level}`,
          value: CARD_VALUE_BASE + (c.level - 1) * CARD_VALUE_PER_LEVEL, locked: c.locked, cls: 'card',
          onPick: () => { this.createClass = 'card'; this.createCardId = c.id; this.closeItemPicker(); },
        });
      }
      entries.sort((a, b) => b.value - a.value);
      return entries;
    }

    openItemPicker(): void {
      this.closeModal();
      this.itemPickerOpen = true;
      this.pickerFilter = '';
      this.scrollY = 0;
      this.render();
    }

    private closeItemPicker(): void {
      this.itemPickerOpen = false;
      this.scrollY = 0;
      this.render();
      this.openCreateForm();
    }

    /** Cancel the picker and return to the create form (keeps any prior selection). */
    cancelItemPicker(): void {
      this.itemPickerOpen = false;
      this.scrollY = 0;
      this.render();
      this.openCreateForm();
    }

    /**
     * Left category rail inside the notebook-margin gutter (All/Equipment/Character-cards/Materials), mirrors the market
     * tab's renderSidebar so the picker reads consistently with the rest of the auction scene. Returns
     * the x where the item grid should start.
     */
    private renderPickerSidebar(): number {
      const { h } = this;
      const sidebarW = marginLineX(this.w);
      const y = this.headerH + 8;
      const keys: Record<AucFilter, 'auction.filterAll' | 'auction.filterEquipment' | 'auction.filterCard' | 'auction.filterMaterial'> = {
        '': 'auction.filterAll', equipment: 'auction.filterEquipment', card: 'auction.filterCard', material: 'auction.filterMaterial',
      };
      const icons: Partial<Record<AucFilter, IconKind>> = { equipment: 'armor', card: 'cards', material: 'scrap' };
      const hubTabs: HubTab[] = FILTERS.map((f) => ({ label: t(keys[f]), active: f === this.pickerFilter, icon: icons[f] }));
      const { hits } = drawSidebarTabs(this.bodyLayer, sidebarW, y, h, hubTabs, (i) => {
        const f = FILTERS[i]!;
        if (this.pickerFilter !== f) { this.pickerFilter = f; this.scrollY = 0; this.render(); }
      });
      for (const hit of hits) this.hitRects.push({ rect: hit.rect, action: hit.fn });
      return sidebarW;
    }

    renderItemPicker(): void {
      const { w, h } = this;
      const titleY = this.headerH + 8;
      const title = txt(t('auction.pickItem'), 14, C.dark, true);
      title.x = 12; title.y = titleY;
      this.bodyLayer.addChild(title);

      const contentX = this.renderPickerSidebar();
      const listY = this.headerH + 40;
      const listH = h - listY - 10;

      const entries = this.buildPickEntries().filter((e) => this.pickerFilter === '' || e.cls === this.pickerFilter);
      if (entries.length === 0) {
        const lbl = txt(t('auction.noItems'), 13, C.dark);
        lbl.anchor.set(0.5, 0.5); lbl.x = contentX + (w - contentX) / 2; lbl.y = listY + listH / 2;
        this.bodyLayer.addChild(lbl);
        return;
      }

      const pad = 12;
      const avail = w - contentX - pad * 2;
      const cols = Math.max(1, Math.floor((avail + CARD_GAP) / (CARD_W_TARGET + CARD_GAP)));
      const cardW = (avail - CARD_GAP * (cols - 1)) / cols;
      const rows = Math.ceil(entries.length / cols);
      const totalH = rows * (CARD_H + CARD_GAP);
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));

      entries.forEach((entry, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cx = contentX + pad + col * (cardW + CARD_GAP);
        const cy = listY + row * (CARD_H + CARD_GAP) - this.scrollY;
        if (cy + CARD_H < listY || cy > listY + listH) return;
        this.renderPickCard(entry, cx, cy, cardW);
      });
    }

    /** Square-ish icon card: glyph centered top, name below, lock badge top-right, tap anywhere to pick. */
    private renderPickCard(entry: PickEntry, x: number, y: number, cardW: number): void {
      const card = sketchPanel(cardW, CARD_H, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(x, y, cardW) });
      card.x = x; card.y = y;
      this.bodyLayer.addChild(card);

      if (entry.locked) {
        const lk = buildIcon('lock', 20, C.mid);
        lk.x = x + cardW - 12 - 20; lk.y = y + 9;
        this.bodyLayer.addChild(lk);
      }

      const ic = buildIcon(entry.icon, 39, C.dark);
      ic.x = x + cardW / 2 - 20; ic.y = y + 18;
      this.bodyLayer.addChild(ic);

      const nameLbl = txt(entry.label, 18, C.dark, true);
      nameLbl.anchor.set(0.5, 0); nameLbl.x = x + cardW / 2; nameLbl.y = y + 78;
      if (nameLbl.width > cardW - 18) nameLbl.scale.set((cardW - 18) / nameLbl.width);
      this.bodyLayer.addChild(nameLbl);

      const hint = txt(t('auction.pickHint'), 15, C.accent, true);
      hint.anchor.set(0.5, 1); hint.x = x + cardW / 2; hint.y = y + CARD_H - 8;
      this.bodyLayer.addChild(hint);

      this.hitRects.push({ rect: { x, y, w: cardW, h: CARD_H }, action: entry.onPick });
    }
  };
}
