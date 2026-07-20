// Inventory tab: sidebar (group nav + Inventory/Craft sub-tabs), slot filter, the loadout strip
// (three equip slots for the active card), and the item grid (icon-card cells, stacked by defId+rarity).
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, marginLineX } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { drawSidebarTabs, sidebarNavW, type HubTab } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import { buildIcon } from '../../render/icons';
import type { SaveData, EquipSlot, EquipRarity, EquipmentInstance } from '../../game/meta/SaveData';
import { getEquipDef } from '../../game/meta/equipmentDefs';
import {
  type Constructor, type EquipmentSceneBaseCtor, type EquipTab,
  LOADOUT_H, FILTER_H, SECTION_H, CELL_GAP, CELL_GAP_X, EQUIP_CELL_H, EQUIP_CELL_W_TARGET,
  SLOTS, RARITY_COLOR,
} from './base';

export type SectionKey = 'equipped' | 'bag';

export type DisplayEntry =
  | { kind: 'header'; label: string; key: SectionKey }
  | { kind: 'item'; inst: EquipmentInstance; count: number; isEquipped: boolean };

export interface InventoryHandlers {
  renderSidebar(): void;
  renderInventory(bodyTop: number): void;
  renderSlotFilter(x: number, y: number, w: number): void;
}

export function InventoryMixin<TBase extends EquipmentSceneBaseCtor>(Base: TBase): TBase & Constructor<InventoryHandlers> {
  return class extends Base {
    /**
     * Section headers (Equipped / Bag) tapped closed by the player; collapsed sections hide their
     * item cells but keep the header visible. Lazily initialized via the getter below — the base
     * class constructor calls render() before this mixin's own field initializers run, so a plain
     * field initializer here would be undefined on first render.
     */
    private _collapsedSections?: Set<SectionKey>;
    private get collapsedSections(): Set<SectionKey> {
      return (this._collapsedSections ??= new Set<SectionKey>());
    }
    /**
     * Left sidebar rail, stacked inside the notebook-margin gutter (`marginLineX`) below the
     * header: the progression group nav [<peer>|Equipment] (LOBBY_IA_REDESIGN P1.5, only when
     * peerTab is injected) on top, then the Inventory/Craft sub-tabs always underneath (this
     * used to be a horizontal strip in the header row's left column — moved here so it isn't
     * squeezed into the same narrow gutter width as a wide strip; see LOBBY_IA_REDESIGN.md §8
     * sidebar addendum).
     */
    renderSidebar(): void {
      const sidebarW = sidebarNavW(this.w, this.h, this.landscape);
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

      // Peers after Equipment in the growth group ([Cards | Equipment | Skins]) render *below* the
      // Inventory/Craft sub-tabs, so the sub-tabs stay nested under Equipment and the trailing peer
      // (Skins) shifts down instead of disappearing — see EquipmentCallbacks.trailingPeers.
      const trailing = this.cb.trailingPeers ?? [];
      if (trailing.length > 0) {
        const ty = sub.bottom + Math.round(this.h * 0.03);
        const peerTabs: HubTab[] = trailing.map((p) => ({ label: t(p.labelKey), active: false, icon: p.icon }));
        const after = drawSidebarTabs(this.bodyLayer, sidebarW, ty, this.h, peerTabs, (i) => trailing[i]?.onSelect());
        for (const hit of after.hits) this.hitRects.push({ rect: hit.rect, action: hit.fn });
      }
    }

    renderInventory(bodyTop: number): void {
      const { w, h } = this;
      const save = this.cb.getSave();
      // Item cells (and the loadout strip below) start right of the sidebar rail.
      const left = sidebarNavW(w, h, this.landscape);
      // Bag mode (no active card) has no single-card loadout to show; the list starts right below the header row.
      let listY = bodyTop;
      if (!this.bag) { this.renderLoadout(save, bodyTop, left); listY = bodyTop + LOADOUT_H; }
      const availH = h - listY - 8;

      const allInstances = Object.values(save.equipmentInv);
      const instances = this.filterSlot === 'all'
        ? allInstances
        : allInstances.filter(x => getEquipDef(x.defId)?.slot === this.filterSlot);

      if (instances.length === 0) {
        const lbl = txt(t('equip.invEmpty'), FS.heading, C.mid);
        lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + availH / 2;
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
      // Item cells start right of the sidebar rail; right pad stays one CELL_GAP.
      const gridLeft = left + CELL_GAP;
      const avail = w - gridLeft - CELL_GAP;
      const cols = Math.max(1, Math.floor((avail + CELL_GAP_X) / (EQUIP_CELL_W_TARGET + CELL_GAP_X)));
      // Cap at the target width instead of stretching to fill the row — dividing the full
      // available width evenly across `cols` left cards much wider than their content needed,
      // reading as mostly blank paper; any leftover width is just unused margin on the right.
      const cellW = Math.min(EQUIP_CELL_W_TARGET, (avail - CELL_GAP_X * (cols - 1)) / cols);

      // Layout pass: headers span a full row and reset the column cursor; item
      // cells pack left-to-right into `cols` columns. `off` is the vertical
      // offset from listY (pre-scroll), computed up-front to clamp scrollY.
      // Items belonging to a collapsed section are skipped entirely (no space reserved).
      type Placed =
        | { kind: 'header'; label: string; key: SectionKey; off: number }
        | { kind: 'item'; inst: EquipmentInstance; isEquipped: boolean; count: number; x: number; off: number };
      const placed: Placed[] = [];
      let off = CELL_GAP;
      let col = 0;
      let collapsed = false;
      for (const entry of entries) {
        if (entry.kind === 'header') {
          if (col !== 0) { off += EQUIP_CELL_H + CELL_GAP; col = 0; }
          collapsed = this.collapsedSections.has(entry.key);
          placed.push({ kind: 'header', label: entry.label, key: entry.key, off });
          off += SECTION_H;
          continue;
        }
        if (collapsed) continue;
        const x = gridLeft + col * (cellW + CELL_GAP_X);
        placed.push({ kind: 'item', inst: entry.inst, isEquipped: entry.isEquipped, count: entry.count, x, off });
        col++;
        if (col >= cols) { col = 0; off += EQUIP_CELL_H + CELL_GAP; }
      }
      if (col !== 0) off += EQUIP_CELL_H + CELL_GAP;
      const totalH = off + CELL_GAP;
      // Clamp the viewport so it always cuts mid-row when there's more below — a partial next card
      // always peeks above the fold instead of the screen looking coincidentally "full".
      const listH = peekViewportH(availH, EQUIP_CELL_H + CELL_GAP, totalH);

      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));

      // Cards are drawn into a masked sub-layer so an overscrolled row never bleeds up past listY
      // and paints over the slot filter bar / loadout strip above it (they only skip rows fully
      // outside [listY, listY+listH], so a row straddling that edge would otherwise render in full).
      const gridLayer = new PIXI.Container();
      this.bodyLayer.addChild(gridLayer);
      const clip = new PIXI.Graphics();
      clip.beginFill(0xffffff).drawRect(0, listY, w, listH).endFill();
      this.bodyLayer.addChild(clip);
      gridLayer.mask = clip;
      const outerLayer = this.bodyLayer;
      this.bodyLayer = gridLayer;
      for (const p of placed) {
        const y = listY + p.off - this.scrollY;
        const eh = p.kind === 'header' ? SECTION_H : EQUIP_CELL_H;
        if (y + eh < listY || y > listY + listH) continue;
        if (p.kind === 'header') this.renderSectionHeader(p.label, p.key, y);
        else this.renderInstanceCell(p.inst, p.x, y, cellW, p.isEquipped, p.count);
      }
      this.bodyLayer = outerLayer;

      drawScrollIndicator(this.bodyLayer, { x: gridLeft, y: listY, w: avail, h: listH }, this.scrollY, Math.max(0, totalH - listH));
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
        const lbl = txt(f.label, FS.label, active ? C.accent : C.dark, active);
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

    /**
     * Section divider header ("Equipped" / "Bag"), aligned with the item grid (right of the
     * sidebar/margin rule, shifted right a bit further so it doesn't hug the rule) and sized 2x
     * for legibility. Tapping it toggles that section's cards collapsed/expanded — the chevron
     * shows the current state. Bold + dark so it reads against the paper texture.
     */
    private renderSectionHeader(label: string, key: SectionKey, cy: number): void {
      const { w } = this;
      const collapsed = this.collapsedSections.has(key);
      const left = marginLineX(w) + CELL_GAP + 20;
      const lbl = txt(`${collapsed ? '▶' : '▼'} ${label}`, FS.label, C.dark, true);
      lbl.x = left; lbl.y = cy + (SECTION_H - lbl.height) / 2;
      this.bodyLayer.addChild(lbl);
      const lineX = lbl.x + lbl.width + 10;
      const lineY = cy + SECTION_H / 2;
      const line = new PIXI.Graphics();
      line.lineStyle(1, C.mid, 0.5).moveTo(lineX, lineY).lineTo(w - 14, lineY);
      this.bodyLayer.addChild(line);
      this.hitRects.push({
        rect: { x: 0, y: cy, w, h: SECTION_H },
        action: () => {
          if (collapsed) this.collapsedSections.delete(key);
          else this.collapsedSections.add(key);
          this.render();
        },
      });
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
          entries.push({ kind: 'header', label: t('equip.sectionEquipped'), key: 'equipped' });
        }
        if (!isEquipped && !inBagSection) {
          inBagSection = true;
          entries.push({ kind: 'header', label: t('equip.sectionBag'), key: 'bag' });
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

    /** Loadout strip (Weapon/Armor/Trinket preview cells), confined to the right column — right of the sidebar rail, mirroring the filter bar and item grid below it. */
    private renderLoadout(save: SaveData, y: number, left: number): void {
      const { w } = this;
      const label = txt(t('equip.loadout'), FS.micro, C.mid);
      label.x = left + 10; label.y = y + 4;
      this.bodyLayer.addChild(label);

      // CC-1: gear lives on the active card instance, not on a global loadout.
      const activeCard = save.cardInv?.[this.cb.activeCardInstanceId];
      const gear = activeCard?.gear ?? {};
      const cellW = (w - left - 8 * 4) / 3;
      const cellH = LOADOUT_H - 28;
      SLOTS.forEach((slot, i) => {
        const x = left + 8 + i * (cellW + 8);
        const cy = y + 22;
        const instId = gear[slot];
        const inst = instId ? save.equipmentInv[instId] : undefined;
        const border = inst ? RARITY_COLOR[inst.rarity] : C.mid;
        const cell = sketchPanel(cellW, cellH, { fill: 0xfaf9f5, border, seed: seedFor(i, 7, cellW) });
        cell.x = x; cell.y = cy;
        this.bodyLayer.addChild(cell);

        // Slot label: when equipped, show the slot type in small text as a secondary hint; when empty, show it bold so the player can easily identify open slots.
        const slotLbl = txt(t(`equip.slot.${slot}` as TranslationKey), FS.micro, inst ? C.mid : C.dark, !inst);
        slotLbl.anchor.set(0.5, 0); slotLbl.x = x + cellW / 2; slotLbl.y = cy + 4;
        this.bodyLayer.addChild(slotLbl);

        if (inst) {
          this.addGlyph(slot, inst.rarity, x + cellW / 2, cy + cellH * 0.4, 30, seedFor(i, 13, cellW), 1, inst.defId);
          const nm = txt(this.itemName(inst.defId), FS.micro, C.dark);
          nm.anchor.set(0.5, 0.5); nm.x = x + cellW / 2; nm.y = cy + cellH * 0.72;
          this.bodyLayer.addChild(nm);
          if (inst.level > 0) {
            const stars = this.buildLevelStars(inst.level, cellW - 8, 10, 2);
            stars.x = x + cellW / 2 - stars.width / 2; stars.y = cy + cellH * 0.86;
            this.bodyLayer.addChild(stars);
          }
          this.hitRects.push({ rect: { x, y: cy, w: cellW, h: cellH }, action: () => this.openDetail(inst.id) });
        } else {
          // Empty slot: darken the glyph alpha (0.40) and add the "empty" label so the player can clearly identify available equip positions.
          this.addGlyph(slot, 'common', x + cellW / 2, cy + cellH * 0.45, 28, seedFor(i, 13, cellW), 0.40);
          const empty = txt(t('equip.slotEmpty'), FS.micro, C.mid);
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

      // Top: name (scaled down to fit if too wide).
      const name = txt(this.itemName(inst.defId), FS.bodyLg, C.dark, true);
      name.x = x + pad; name.y = y + pad;
      if (name.width > cellW - pad * 2 - 20) name.scale.set(Math.min(1, cellW / (name.width + 40)));
      this.bodyLayer.addChild(name);

      // Lock badge (top-right).
      if (inst.locked) {
        const l = buildIcon('lock', 18, C.mid);
        l.x = x + cellW - pad - 18; l.y = y + pad;
        this.bodyLayer.addChild(l);
      }

      // Enhance level as a row of gold stars beneath the name, in place of the old "+N" suffix
      // (matches the Hero Roster / Card level-star convention). Header row grows to make room.
      const headerH = inst.level > 0 ? 40 : 32;
      if (inst.level > 0) {
        const stars = this.buildLevelStars(inst.level, cellW - pad * 2);
        stars.x = x + pad; stars.y = y + pad + 20;
        this.bodyLayer.addChild(stars);
      }

      // Left: glyph in a rarity-bordered frame.
      const slot = getEquipDef(inst.defId)?.slot ?? 'weapon';
      const imgBox = EQUIP_CELL_H - (pad + headerH) - pad;
      const imgX = x + pad;
      const imgY = y + pad + headerH;
      const frame = sketchPanel(imgBox, imgBox, { fill: 0xf0eee7, border: color, seed: seedFor(x, y, imgBox) });
      frame.x = imgX; frame.y = imgY;
      this.bodyLayer.addChild(frame);
      this.addGlyph(slot, inst.rarity, imgX + imgBox / 2, imgY + imgBox / 2, imgBox - 8, seedFor(x, imgBox, cellW), 1, inst.defId);

      // Right: rarity / equipped tag / stack count on top, action affordance anchored to the
      // bottom of the column — sized to the glyph frame's height so the column no longer reads
      // as mostly blank paper for common items with nothing but a rarity line to show.
      const ax = imgX + imgBox + 12;
      const colW = x + cellW - pad - ax;
      let ay = imgY + 4;
      const rar = txt(t(`equip.rarity.${inst.rarity}` as TranslationKey), FS.body, color, true);
      rar.x = ax; rar.y = ay; this.bodyLayer.addChild(rar); ay += 28;
      if (equipped) {
        const slotLabel = t(`equip.slot.${slot}` as TranslationKey);
        const e = txt(`[${t('equip.equipped')} · ${slotLabel}]`, FS.small, C.green, true);
        if (e.width > colW) e.scale.set(Math.max(0.01, colW / e.width));
        e.x = ax; e.y = ay; this.bodyLayer.addChild(e); ay += 24;
      }
      if (count > 1) {
        const badge = txt(`×${count}`, FS.body, C.mid);
        badge.x = ax; badge.y = ay; this.bodyLayer.addChild(badge);
      }

      // Bottom-of-column action affordance: unequipped items get a real button (fill + border),
      // so "this is the thing to tap to equip" reads at a glance instead of small corner text
      // competing visually with the equipped row's quiet detail-view chevron.
      const btnH = 36;
      const btnY = imgY + imgBox - btnH;
      if (equipped) {
        const hint = txt('› ' + t('equip.viewDetails'), FS.small, C.mid);
        hint.anchor.set(1, 1); hint.x = x + cellW - pad; hint.y = y + EQUIP_CELL_H - pad;
        this.bodyLayer.addChild(hint);
      } else {
        const btn = sketchPanel(colW, btnH, { fill: 0xf3ede0, border: C.accent, seed: seedFor(ax, btnY, colW) });
        btn.x = ax; btn.y = btnY;
        this.bodyLayer.addChild(btn);
        const label = txt(t('equip.hintEquip'), FS.body, C.accent, true);
        label.anchor.set(0.5, 0.5); label.x = ax + colW / 2; label.y = btnY + btnH / 2;
        this.bodyLayer.addChild(label);
      }

      this.hitRects.push({ rect: { x, y, w: cellW, h: EQUIP_CELL_H }, action: () => this.openDetail(inst.id) });
    }
  };
}
