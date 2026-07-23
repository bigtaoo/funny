// Unified item picker (scene-level overlay): choosing what to list, reached from the create form's item
// field. Lists every sellable item across all three classes (materials + equipment + cards) in one scrollable
// list, sorted by estimated value descending. Picking an entry returns to the create form.
import * as PIXI from 'pixi.js-legacy';
import { AUCTION_STATIC_REF_PRICE } from '@nw/shared';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { drawSidebarTabs, sidebarNavW, type HubTab } from '../../ui/widgets/HubTabs';
import { t } from '../../i18n';
import { buildIcon, type IconKind } from '../../render/icons';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import type { EquipmentInstance, CardInstance, EquipRarity } from '../../game/meta/SaveData';
import { getEquipDef } from '../../game/meta/equipmentDefs';
import { buildEquipIcon } from '../../render/equipmentAtlas';
import { CARD_DEFS } from '../../game/meta/cardDefs';
import { UNIT_ART_URLS, getArtTexture } from '../../render/cardArt';
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
  label: string;
  value: number;
  locked: boolean;
  cls: 'material' | 'equipment' | 'card';
  /** Material glyph name (cls === 'material') or def id (equipment/card) used to resolve the real per-item picture. */
  material?: typeof MATERIALS[number];
  defId?: string;
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

    /**
     * Combined pick list across all three classes, sorted by estimated value descending.
     * Equipment/card instances are grouped by defId+level: a stack of identical drops (e.g. a dozen
     * "Marker +0") would otherwise repeat the same card dozens of times. Each listing only ever escrows
     * one instance anyway (qty forced to 1 server-side), so any instance in the group is an equally
     * valid pick — the label just appends "×N" so the count isn't lost.
     */
    private buildPickEntries(): PickEntry[] {
      const entries: PickEntry[] = [];
      for (const mat of MATERIALS) {
        entries.push({
          material: mat, label: t(`auction.${mat}` as 'auction.scrap' | 'auction.lead' | 'auction.binding'),
          value: AUCTION_STATIC_REF_PRICE[mat] ?? 0, locked: false, cls: 'material',
          onPick: () => { this.createClass = 'material'; this.createMaterial = mat; this.closeItemPicker(); },
        });
      }

      const equipGroups = new Map<string, { rep: EquipmentInstance; count: number }>();
      for (const e of this.listableEquipment()) {
        const key = `${e.defId}:${e.level}`;
        const g = equipGroups.get(key);
        if (g) g.count++; else equipGroups.set(key, { rep: e, count: 1 });
      }
      for (const { rep, count } of equipGroups.values()) {
        const base = `${this.equipName(rep.defId)} +${rep.level}`;
        entries.push({
          defId: rep.defId, label: count > 1 ? `${base} ×${count}` : base,
          value: EQUIP_VALUE_BY_RARITY[rep.rarity] ?? 0, locked: false, cls: 'equipment',
          onPick: () => { this.createClass = 'equipment'; this.createEquipId = rep.id; this.closeItemPicker(); },
        });
      }

      const cardGroups = new Map<string, { rep: CardInstance; count: number }>();
      for (const c of this.listableCards()) {
        const key = `${c.defId}:${c.level}`;
        const g = cardGroups.get(key);
        if (g) {
          g.count++;
          if (!c.locked && g.rep.locked) g.rep = c; // prefer an unlocked instance as the pick target
        } else {
          cardGroups.set(key, { rep: c, count: 1 });
        }
      }
      for (const { rep, count } of cardGroups.values()) {
        const base = `${this.cardName(rep.defId)} Lv.${rep.level}`;
        entries.push({
          defId: rep.defId, label: count > 1 ? `${base} ×${count}` : base,
          value: CARD_VALUE_BASE + (rep.level - 1) * CARD_VALUE_PER_LEVEL, locked: rep.locked, cls: 'card',
          onPick: () => { this.createClass = 'card'; this.createCardId = rep.id; this.closeItemPicker(); },
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
      const { w, h, landscape } = this;
      const sidebarW = sidebarNavW(w, h, landscape);
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
      const title = txt(t('auction.pickItem'), FS.tiny, C.dark, true);
      title.x = 12; title.y = titleY;
      this.bodyLayer.addChild(title);

      const contentX = this.renderPickerSidebar();
      const listY = this.headerH + 40;
      const availH = h - listY - 10;
      // Default to "nothing to scroll" — overwritten below once the real grid geometry is known;
      // covers the empty-entries early-return so a stale wheel event can't scroll a hidden grid.
      this.scrollMax = 0;

      const entries = this.buildPickEntries().filter((e) => this.pickerFilter === '' || e.cls === this.pickerFilter);
      if (entries.length === 0) {
        const lbl = txt(t('auction.noItems'), FS.tiny, C.dark);
        lbl.anchor.set(0.5, 0.5); lbl.x = contentX + (w - contentX) / 2; lbl.y = listY + availH / 2;
        this.bodyLayer.addChild(lbl);
        return;
      }

      const pad = 12;
      const avail = w - contentX - pad * 2;
      const cols = Math.max(1, Math.floor((avail + CARD_GAP) / (CARD_W_TARGET + CARD_GAP)));
      const cardW = (avail - CARD_GAP * (cols - 1)) / cols;
      const rows = Math.ceil(entries.length / cols);
      const totalH = rows * (CARD_H + CARD_GAP);
      // No PIXI mask backs this grid (draw-cull only, below) — a row is either drawn in full or
      // skipped entirely, never cropped, so peekViewportH's mid-row shrink would just exclude a
      // row that fits fine and leave a dead gap (2026-07-23 correction, UI_DESIGN.md §25). Use the
      // naive availH directly (also the wheel-scroll viewport bounds, see wheelScroll.ts).
      this.scrollMax = Math.max(0, totalH - availH);
      this.scrollY = Math.max(0, Math.min(this.scrollY, this.scrollMax));
      this.scrollRegionTop = listY;
      this.scrollRegionBottom = listY + availH;

      entries.forEach((entry, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cx = contentX + pad + col * (cardW + CARD_GAP);
        const cy = listY + row * (CARD_H + CARD_GAP) - this.scrollY;
        if (cy + CARD_H < listY || cy > listY + availH) return;
        this.renderPickCard(entry, cx, cy, cardW);
      });

      drawScrollIndicator(this.bodyLayer, { x: contentX + pad, y: listY, w: avail, h: availH }, this.scrollY, Math.max(0, totalH - availH));
    }

    /**
     * Real per-item picture (mirrors list.ts's renderAuctionCell): equipment gets its per-slot/rarity
     * procedural glyph, cards get the real unit art PNG, materials keep their dedicated icon glyph.
     * Centered at (cx, cy) in a `size`×`size` box.
     */
    private renderPickIcon(entry: PickEntry, cx: number, cy: number, size: number, seed: number): void {
      if (entry.cls === 'equipment' && entry.defId) {
        const def = getEquipDef(entry.defId);
        if (def) {
          const icon = buildEquipIcon(entry.defId, def.slot, def.rarity, size, seed);
          icon.x = cx; icon.y = cy;
          this.bodyLayer.addChild(icon);
          return;
        }
      } else if (entry.cls === 'card' && entry.defId) {
        const cardDef = CARD_DEFS[entry.defId];
        const artUrl = cardDef ? UNIT_ART_URLS[cardDef.unitType] : undefined;
        if (artUrl) {
          const tex = getArtTexture(artUrl);
          if (tex.baseTexture.valid) {
            const scale = Math.min(size / tex.width, size / tex.height);
            const sp = new PIXI.Sprite(tex);
            sp.anchor.set(0.5);
            sp.scale.set(scale);
            sp.position.set(cx, cy);
            this.bodyLayer.addChild(sp);
            return;
          }
          if (!this.artHooked.has(artUrl)) {
            this.artHooked.add(artUrl);
            tex.baseTexture.once('loaded', () => this.render());
          }
        }
      }
      const fallback: IconKind = entry.cls === 'material' ? (entry.material ?? 'scrap') : entry.cls === 'equipment' ? 'armor' : 'cards';
      const icon = buildIcon(fallback, size, C.dark);
      icon.x = cx - size / 2; icon.y = cy - size / 2;
      this.bodyLayer.addChild(icon);
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

      this.renderPickIcon(entry, x + cardW / 2, y + 18 + 19.5, 39, seedFor(x, y, cardW));

      const nameLbl = txt(entry.label, FS.body, C.dark, true);
      nameLbl.anchor.set(0.5, 0); nameLbl.x = x + cardW / 2; nameLbl.y = y + 78;
      if (nameLbl.width > cardW - 18) nameLbl.scale.set((cardW - 18) / nameLbl.width);
      this.bodyLayer.addChild(nameLbl);

      const hint = txt(t('auction.pickHint'), FS.small, C.accent, true);
      hint.anchor.set(0.5, 1); hint.x = x + cardW / 2; hint.y = y + CARD_H - 8;
      this.bodyLayer.addChild(hint);

      this.hitRects.push({ rect: { x, y, w: cardW, h: CARD_H }, action: entry.onPick });
    }
  };
}
