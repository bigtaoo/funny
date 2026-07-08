// Inventory tab: sidebar (group nav + Inventory/Craft sub-tabs), slot filter, the loadout strip
// (three equip slots for the active card), and the item grid (icon-card cells, stacked by defId+rarity).
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, marginLineX } from '../../render/sketchUi';
import { drawSidebarTabs, type HubTab } from '../../ui/widgets/HubTabs';
import { buildIcon } from '../../render/icons';
import type { SaveData, EquipSlot, EquipRarity, EquipmentInstance } from '../../game/meta/SaveData';
import { getEquipDef } from '../../game/meta/equipmentDefs';
import {
  type Constructor, type EquipmentSceneBaseCtor, type EquipTab,
  LOADOUT_H, FILTER_H, SECTION_H, CELL_GAP, EQUIP_CELL_H, EQUIP_CELL_W_TARGET,
  SLOTS, RARITY_COLOR,
} from './base';

export type DisplayEntry =
  | { kind: 'header'; label: string }
  | { kind: 'item'; inst: EquipmentInstance; count: number; isEquipped: boolean };

export interface InventoryHandlers {
  renderSidebar(): void;
  renderInventory(bodyTop: number): void;
  renderSlotFilter(x: number, y: number, w: number): void;
}

export function InventoryMixin<TBase extends EquipmentSceneBaseCtor>(Base: TBase): TBase & Constructor<InventoryHandlers> {
  return class extends Base {
    /**
     * Left sidebar rail, stacked inside the notebook-margin gutter (`marginLineX`) below the
     * header: the progression group nav [<peer>|Equipment] (LOBBY_IA_REDESIGN P1.5, only when
     * peerTab is injected) on top, then the Inventory/Craft sub-tabs always underneath (this
     * used to be a horizontal strip in the header row's left column — moved here so it isn't
     * squeezed into the same narrow gutter width as a wide strip; see LOBBY_IA_REDESIGN.md §8
     * sidebar addendum).
     */
    renderSidebar(): void {
      const sidebarW = marginLineX(this.w);
      let y = this.headerH;

      if (this.showGroup && this.cb.peerTab) {
        const groupTabs: HubTab[] = [
          { label: t(this.cb.peerTab.labelKey), active: false, icon: this.cb.peerTab.icon },
          { label: t('equip.title'), active: true, icon: 'armor' },
        ];
        const group = drawSidebarTabs(this.bodyLayer, sidebarW, y, this.h, groupTabs, (i) => {
          if (i === 0) this.cb.peerTab?.onSelect();
        });
        for (const hit of group.hits) this.hitRects.push({ rect: hit.rect, action: hit.fn });
        y = group.bottom + Math.round(this.h * 0.03);
      }

      const subTabs: { key: EquipTab; label: TranslationKey }[] = [
        { key: 'inv', label: 'equip.tabInv' },
        { key: 'craft', label: 'equip.tabCraft' },
      ];
      const sub = drawSidebarTabs(
        this.bodyLayer, sidebarW, y, this.h,
        subTabs.map((tab) => ({ label: t(tab.label), active: tab.key === this.activeTab })),
        (i) => {
          const key = subTabs[i].key;
          if (this.activeTab !== key) { this.activeTab = key; this.scrollY = 0; this.render(); }
        },
        { sub: true },
      );
      for (const hit of sub.hits) this.hitRects.push({ rect: hit.rect, action: hit.fn });
    }

    renderInventory(bodyTop: number): void {
      const { w, h } = this;
      const save = this.cb.getSave();
      // Bag mode (no active card) has no single-card loadout to show; the list starts right below the header row.
      let listY = bodyTop;
      if (!this.bag) { this.renderLoadout(save, bodyTop); listY = bodyTop + LOADOUT_H; }
      const listH = h - listY - 8;

      const allInstances = Object.values(save.equipmentInv);
      const instances = this.filterSlot === 'all'
        ? allInstances
        : allInstances.filter(x => getEquipDef(x.defId)?.slot === this.filterSlot);

      if (instances.length === 0) {
        const lbl = txt(t('equip.invEmpty'), 13, C.mid);
        lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + listH / 2;
        this.bodyLayer.addChild(lbl);
        return;
      }

      // Sort: equipped first, then rarity desc, then level desc — stable, deterministic.
      const rarOrder: EquipRarity[] = ['epic', 'rare', 'fine', 'common'];
      const equippedIds = this.equippedIds(save);
      instances.sort((a, b) => {
        const ea = equippedIds.has(a.id) ? 0 : 1;
        const eb = equippedIds.has(b.id) ? 0 : 1;
        if (ea !== eb) return ea - eb;
        const ra = rarOrder.indexOf(a.rarity) - rarOrder.indexOf(b.rarity);
        if (ra !== 0) return ra;
        if (b.level !== a.level) return b.level - a.level;
        return a.id < b.id ? -1 : 1;
      });

      const entries = this.buildDisplayEntries(instances, equippedIds);
      // Item cells start right of the red margin rule; right pad stays one CELL_GAP.
      const left = marginLineX(w) + CELL_GAP;
      const avail = w - left - CELL_GAP;
      const cols = Math.max(1, Math.floor((avail + CELL_GAP) / (EQUIP_CELL_W_TARGET + CELL_GAP)));
      const cellW = (avail - CELL_GAP * (cols - 1)) / cols;

      // Layout pass: headers span a full row and reset the column cursor; item
      // cells pack left-to-right into `cols` columns. `off` is the vertical
      // offset from listY (pre-scroll), computed up-front to clamp scrollY.
      type Placed =
        | { kind: 'header'; label: string; off: number }
        | { kind: 'item'; inst: EquipmentInstance; isEquipped: boolean; count: number; x: number; off: number };
      const placed: Placed[] = [];
      let off = CELL_GAP;
      let col = 0;
      for (const entry of entries) {
        if (entry.kind === 'header') {
          if (col !== 0) { off += EQUIP_CELL_H + CELL_GAP; col = 0; }
          placed.push({ kind: 'header', label: entry.label, off });
          off += SECTION_H;
          continue;
        }
        const x = left + col * (cellW + CELL_GAP);
        placed.push({ kind: 'item', inst: entry.inst, isEquipped: entry.isEquipped, count: entry.count, x, off });
        col++;
        if (col >= cols) { col = 0; off += EQUIP_CELL_H + CELL_GAP; }
      }
      if (col !== 0) off += EQUIP_CELL_H + CELL_GAP;
      const totalH = off + CELL_GAP;

      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));
      for (const p of placed) {
        const y = listY + p.off - this.scrollY;
        const eh = p.kind === 'header' ? SECTION_H : EQUIP_CELL_H;
        if (y + eh < listY || y > listY + listH) continue;
        if (p.kind === 'header') this.renderSectionHeader(p.label, y);
        else this.renderInstanceCell(p.inst, p.x, y, cellW, p.isEquipped, p.count);
      }
    }

    /** Slot filter bar (All / Weapon / Armor / Trinket), confined to [x, x+w) — the right column. */
    renderSlotFilter(x: number, y: number, w: number): void {
      const filters: { key: EquipSlot | 'all'; label: string }[] = [
        { key: 'all',     label: t('equip.filterAll') },
        { key: 'weapon',  label: t('equip.slot.weapon') },
        { key: 'armor',   label: t('equip.slot.armor') },
        { key: 'trinket', label: t('equip.slot.trinket') },
      ];
      const fw = w / filters.length;
      const bg = new PIXI.Graphics();
      bg.beginFill(0xe8e5da).drawRect(x, y, w, FILTER_H).endFill();
      this.bodyLayer.addChild(bg);

      filters.forEach((f, i) => {
        const active = this.filterSlot === f.key;
        const fx = x + i * fw;
        if (active) {
          const hlt = new PIXI.Graphics();
          hlt.beginFill(0xfaf9f5).drawRoundedRect(fx + 3, y + 3, fw - 6, FILTER_H - 6, 3).endFill();
          this.bodyLayer.addChild(hlt);
        }
        const lbl = txt(f.label, 11, active ? C.accent : C.dark, active);
        lbl.anchor.set(0.5, 0.5); lbl.x = fx + fw / 2; lbl.y = y + FILTER_H / 2;
        this.bodyLayer.addChild(lbl);
        this.hitRects.push({
          rect: { x: fx, y, w: fw, h: FILTER_H },
          action: () => {
            if (this.filterSlot !== f.key) { this.filterSlot = f.key; this.scrollY = 0; this.render(); }
          },
        });
      });
    }

    /** Section divider header ("Equipped" / "Bag"), aligned with the item grid (right of the sidebar/margin rule). Bold + dark so it reads against the paper texture. */
    private renderSectionHeader(label: string, cy: number): void {
      const { w } = this;
      const left = marginLineX(w) + CELL_GAP;
      const lbl = txt(label, 12, C.dark, true);
      lbl.x = left; lbl.y = cy + (SECTION_H - lbl.height) / 2;
      this.bodyLayer.addChild(lbl);
      const lineX = lbl.x + lbl.width + 6;
      const lineY = cy + SECTION_H / 2;
      const line = new PIXI.Graphics();
      line.lineStyle(1, C.mid, 0.5).moveTo(lineX, lineY).lineTo(w - 14, lineY);
      this.bodyLayer.addChild(line);
    }

    /**
     * Convert a sorted instance list into display entries with section headers and stack counts.
     * - Same defId + rarity + level=0, not equipped and not locked → merged into one row (shows ×N).
     * - Equipped / locked / level>0 → always a separate row.
     * - One section header is inserted for the Equipped section and one for the Bag section.
     */
    private buildDisplayEntries(
      sorted: EquipmentInstance[],
      equippedIds: Set<string>,
    ): DisplayEntry[] {
      const entries: DisplayEntry[] = [];
      let inEquippedSection = false;
      let inBagSection = false;
      const seenStacks = new Set<string>();

      for (const inst of sorted) {
        const isEquipped = equippedIds.has(inst.id);

        if (isEquipped && !inEquippedSection) {
          inEquippedSection = true;
          entries.push({ kind: 'header', label: t('equip.sectionEquipped') });
        }
        if (!isEquipped && !inBagSection) {
          inBagSection = true;
          entries.push({ kind: 'header', label: t('equip.sectionBag') });
        }

        if (isEquipped || inst.locked || inst.level > 0) {
          entries.push({ kind: 'item', inst, count: 1, isEquipped });
          continue;
        }

        // Unenhanced items are stackable: merge by defId+rarity.
        const key = `${inst.defId}:${inst.rarity}`;
        if (seenStacks.has(key)) continue;
        seenStacks.add(key);
        const count = sorted.filter(
          x => !equippedIds.has(x.id) && !x.locked && x.level === 0 &&
               x.defId === inst.defId && x.rarity === inst.rarity,
        ).length;
        entries.push({ kind: 'item', inst, count, isEquipped: false });
      }

      return entries;
    }

    private renderLoadout(save: SaveData, y: number): void {
      const { w } = this;
      const label = txt(t('equip.loadout'), 11, C.mid);
      label.x = 10; label.y = y + 4;
      this.bodyLayer.addChild(label);

      // CC-1: gear lives on the active card instance, not on a global loadout.
      const activeCard = save.cardInv?.[this.cb.activeCardInstanceId];
      const gear = activeCard?.gear ?? {};
      const cellW = (w - 8 * 4) / 3;
      const cellH = LOADOUT_H - 28;
      SLOTS.forEach((slot, i) => {
        const x = 8 + i * (cellW + 8);
        const cy = y + 22;
        const instId = gear[slot];
        const inst = instId ? save.equipmentInv[instId] : undefined;
        const border = inst ? RARITY_COLOR[inst.rarity] : C.mid;
        const cell = sketchPanel(cellW, cellH, { fill: 0xfaf9f5, border, seed: seedFor(i, 7, cellW) });
        cell.x = x; cell.y = cy;
        this.bodyLayer.addChild(cell);

        // Slot label: when equipped, show the slot type in small text as a secondary hint; when empty, show it bold so the player can easily identify open slots.
        const slotLbl = txt(t(`equip.slot.${slot}` as TranslationKey), inst ? 10 : 11, inst ? C.mid : C.dark, !inst);
        slotLbl.anchor.set(0.5, 0); slotLbl.x = x + cellW / 2; slotLbl.y = cy + 4;
        this.bodyLayer.addChild(slotLbl);

        if (inst) {
          this.addGlyph(slot, inst.rarity, x + cellW / 2, cy + cellH * 0.4, 30, seedFor(i, 13, cellW), 1, inst.defId);
          const nm = txt(`${this.itemName(inst.defId)} +${inst.level}`, 11, C.dark);
          nm.anchor.set(0.5, 0.5); nm.x = x + cellW / 2; nm.y = cy + cellH * 0.82;
          this.bodyLayer.addChild(nm);
          this.hitRects.push({ rect: { x, y: cy, w: cellW, h: cellH }, action: () => this.openDetail(inst.id) });
        } else {
          // Empty slot: darken the glyph alpha (0.40) and add the "empty" label so the player can clearly identify available equip positions.
          this.addGlyph(slot, 'common', x + cellW / 2, cy + cellH * 0.45, 28, seedFor(i, 13, cellW), 0.40);
          const empty = txt(t('equip.slotEmpty'), 11, C.mid);
          empty.anchor.set(0.5, 0.5); empty.x = x + cellW / 2; empty.y = cy + cellH * 0.88;
          this.bodyLayer.addChild(empty);
        }
      });
    }

    /**
     * Icon-card cell: name +level across the top, equipment glyph on the left,
     * rarity / equipped tag / stack count on the right, action hint bottom-right.
     * Border color encodes rarity when equipped, neutral otherwise.
     */
    private renderInstanceCell(inst: EquipmentInstance, x: number, y: number, cellW: number, equipped: boolean, count = 1): void {
      const pad = 8;
      const color = RARITY_COLOR[inst.rarity];
      // Border always encodes rarity (equipped or not) so the color language is consistent
      // across the Equipped strip and the Bag grid — it used to fall back to neutral grey
      // for unequipped items, which made rarity only readable via the text label.
      const cell = sketchPanel(cellW, EQUIP_CELL_H, { fill: 0xfaf9f5, border: color, seed: seedFor(x, y, cellW) });
      cell.x = x; cell.y = y;
      this.bodyLayer.addChild(cell);

      // Top: name +level (scaled down to fit if too wide).
      const name = txt(`${this.itemName(inst.defId)} +${inst.level}`, 13, C.dark, true);
      name.x = x + pad; name.y = y + pad;
      if (name.width > cellW - pad * 2 - 16) name.scale.set(Math.min(1, cellW / (name.width + 32)));
      this.bodyLayer.addChild(name);

      // Lock badge (top-right).
      if (inst.locked) {
        const l = buildIcon('lock', 14, C.mid);
        l.x = x + cellW - pad - 14; l.y = y + pad;
        this.bodyLayer.addChild(l);
      }

      // Left: glyph in a rarity-bordered frame.
      const slot = getEquipDef(inst.defId)?.slot ?? 'weapon';
      const imgBox = EQUIP_CELL_H - (pad + 24) - pad;
      const imgX = x + pad;
      const imgY = y + pad + 24;
      const frame = sketchPanel(imgBox, imgBox, { fill: 0xf0eee7, border: color, seed: seedFor(x, y, imgBox) });
      frame.x = imgX; frame.y = imgY;
      this.bodyLayer.addChild(frame);
      this.addGlyph(slot, inst.rarity, imgX + imgBox / 2, imgY + imgBox / 2, imgBox - 8, seedFor(x, imgBox, cellW), 1, inst.defId);

      // Right: rarity / equipped tag / stack count.
      const ax = imgX + imgBox + 12;
      let ay = imgY;
      const rar = txt(t(`equip.rarity.${inst.rarity}` as TranslationKey), 12, color, true);
      rar.x = ax; rar.y = ay; this.bodyLayer.addChild(rar); ay += 19;
      if (equipped) {
        const slotLabel = t(`equip.slot.${slot}` as TranslationKey);
        const e = txt(`[${t('equip.equipped')} · ${slotLabel}]`, 11, C.green, true);
        e.x = ax; e.y = ay; this.bodyLayer.addChild(e); ay += 18;
      }
      if (count > 1) {
        const badge = txt(`×${count}`, 12, C.mid);
        badge.x = ax; badge.y = ay; this.bodyLayer.addChild(badge);
      }

      // Bottom-right action hint: "Equip ›" (accent) when unequipped, quiet "›" when equipped.
      const hint = txt(equipped ? '›' : t('equip.hintEquip'), equipped ? 16 : 11, equipped ? C.mid : C.accent, !equipped);
      hint.anchor.set(1, 1); hint.x = x + cellW - pad; hint.y = y + EQUIP_CELL_H - pad;
      this.bodyLayer.addChild(hint);

      this.hitRects.push({ rect: { x, y, w: cellW, h: EQUIP_CELL_H }, action: () => this.openDetail(inst.id) });
    }
  };
}
