// Inventory tab: sidebar (group nav + Inventory/Craft sub-tabs), slot filter, the loadout strip
// (three equip slots for the active card), and the item grid (icon-card cells, stacked by defId+rarity).
//
// Depends on `detail` (instanceActions/openDetail) as a direct constructor param — DetailPanel is
// constructed before InventoryPanel (see core.ts's file-header comment). refreshInstanceCell (the
// single-cell in-place redraw optimization detail.ts's doEnhance uses) is wired onto
// `core.refreshInstanceCellHook` by the outer assembly right after this class is constructed.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, marginLineX, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { buildIcon, type IconKind } from '../../render/icons';
import { drawSidebarTabs, drawBottomNavTabs, sidebarNavW, bottomNavH, type HubTab } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import type { SaveData, EquipSlot, EquipRarity, EquipmentInstance } from '../../game/meta/SaveData';
import { getEquipDef } from '../../game/meta/equipmentDefs';
import {
  LOADOUT_H, FILTER_H, SECTION_H, CELL_GAP, CELL_GAP_X, EQUIP_CELL_H, equipGridColumns, LIST_TOP_PAD,
} from './layout';
import { equippedIds } from './helpers';
import { EQUIP_SUBTABS, type SectionKey } from './types';
import type { EquipmentSceneCore } from './core';
import type { DetailPanel } from './detail';
import { renderInstanceCell, renderLoadout } from './cells';

export type { SectionKey };

export type DisplayEntry =
  | { kind: 'header'; label: string; key: SectionKey }
  | { kind: 'item'; inst: EquipmentInstance; count: number; isEquipped: boolean };

export class InventoryPanel {
  /**
   * Per-instance cell container + on-screen rect from the last renderInventory layout pass — lets
   * refreshInstanceCell() redraw a single cell in place instead of a full relayout. Only populated
   * for on-screen, non-header rows; cleared and rebuilt on every full renderInventory.
   *
   * Unlike the old mixin-chain version, a plain `= new Map()` initializer is safe here: the outer
   * assembly's first render() call happens strictly after every domain class (including this one)
   * has finished constructing, so there's no window where render() runs before this field is set.
   */
  private cellContainers = new Map<string, PIXI.Container>();
  private cellRects = new Map<string, { x: number; y: number; w: number }>();
  /**
   * Ordered signature (header/item keys + stack counts) of the last renderInventory's display
   * entries. refreshInstanceCell() recomputes this fresh and compares — a mismatch means an
   * enhance's level-up reshuffled the stack grouping or the level-desc sort order, so the cached
   * cell rects are no longer trustworthy and it must fall back to a full render().
   */
  private lastEntrySig: string[] = [];

  constructor(
    private readonly core: EquipmentSceneCore,
    private readonly detail: DetailPanel,
  ) {}

  /** Filter + sort pass shared by renderInventory and refreshInstanceCell (kept identical so a
   *  fast-path signature comparison is meaningful). */
  private sortedInstances(save: SaveData): EquipmentInstance[] {
    const allInstances = Object.values(save.equipmentInv);
    const instances = this.core.filterSlot === 'all'
      ? allInstances
      : allInstances.filter(x => getEquipDef(x.defId)?.slot === this.core.filterSlot);
    const rarOrder: EquipRarity[] = ['epic', 'rare', 'fine', 'common'];
    const equippedSet = equippedIds(save);
    instances.sort((a, b) => {
      const ea = equippedSet.has(a.id) ? 0 : 1;
      const eb = equippedSet.has(b.id) ? 0 : 1;
      if (ea !== eb) return ea - eb;
      const ra = rarOrder.indexOf(a.rarity) - rarOrder.indexOf(b.rarity);
      if (ra !== 0) return ra;
      if (b.level !== a.level) return b.level - a.level;
      return a.id < b.id ? -1 : 1;
    });
    return instances;
  }

  private entrySignature(entries: DisplayEntry[]): string[] {
    return entries.map(e => (e.kind === 'header' ? `h:${e.key}` : `i:${e.inst.id}:${e.count}`));
  }

  /**
   * Redraw one grid cell in place (level/affix/action changes only) after an enhance whose level
   * change doesn't reorder or regroup the list, instead of a full renderInventory relayout — see
   * DetailPanel.doEnhance (via core.refreshInstanceCellHook). Returns false (caller falls back to
   * render()) when the cell isn't on-screen/tracked, the entries signature changed since the last
   * full render (stack split or a level-desc reorder within the same rarity group), or the instance
   * is also mirrored in the loadout strip above (equipped gear needs that refreshed too).
   */
  refreshInstanceCell(instanceId: string): boolean {
    const core = this.core;
    if (core.activeTab !== 'inv' || core.assign) return false;
    const container = this.cellContainers.get(instanceId);
    const rect = this.cellRects.get(instanceId);
    if (!container || container.destroyed || !rect) return false;

    const save = core.cb.getSave();
    const inst = save.equipmentInv[instanceId];
    if (!inst) return false;
    const equippedSet = equippedIds(save);
    if (equippedSet.has(instanceId)) return false;

    const entries = this.buildDisplayEntries(this.sortedInstances(save), equippedSet);
    const sig = this.entrySignature(entries);
    if (sig.length !== this.lastEntrySig.length || sig.some((s, i) => s !== this.lastEntrySig[i])) return false;
    const entry = entries.find(
      (e): e is Extract<DisplayEntry, { kind: 'item' }> => e.kind === 'item' && e.inst.id === instanceId,
    );
    if (!entry) return false;

    tearDownChildren(container);
    core.hitRects = core.hitRects.filter((h) => h.owner !== instanceId);
    const outerLayer = core.bodyLayer;
    core.bodyLayer = container;
    renderInstanceCell(core, this.detail, inst, rect.x, rect.y, rect.w, entry.isEquipped, entry.count);
    core.bodyLayer = outerLayer;
    this.lastEntrySig = sig;
    return true;
  }

  /**
   * Landscape: left sidebar rail, stacked inside the notebook-margin gutter (`marginLineX`) below
   * the header — the progression group nav [<peer>|Equipment] (LOBBY_IA_REDESIGN P1.5, only when
   * peerTab is injected) on top, then the Inventory/Craft sub-tabs always underneath, then any
   * trailing peers (Skins) below that (EquipmentCallbacks.trailingPeers) so they shift down
   * instead of disappearing (see LOBBY_IA_REDESIGN.md §8 sidebar addendum).
   *
   * Portrait (§18): the left rail becomes a bottom nav bar, and there's no "nested under" concept
   * left for a single bar to express — so all the *peer-level* items (leading peerTab + Equipment
   * itself + trailing peers) combine into ONE bottom bar (they're all peers of the same growth
   * group, just split across landscape's before/after-subtabs stacking for a different reason).
   * The Inventory/Craft sub-tabs move to a header strip instead — see the assembly's renderHeaderRow.
   */
  renderSidebar(): void {
    const core = this.core;
    const { w, h, landscape } = core;

    if (!landscape) {
      if (!core.hasGroupNav) return;
      const peers: HubTab[] = [];
      const actions: Array<() => void> = [];
      if (core.showGroup && core.cb.peerTab) {
        peers.push({ label: t(core.cb.peerTab.labelKey), active: false, icon: core.cb.peerTab.icon });
        actions.push(() => core.cb.peerTab?.onSelect());
      }
      peers.push({ label: t('equip.title'), active: true, icon: 'equipIcon' });
      actions.push(() => {});
      for (const p of core.cb.trailingPeers ?? []) {
        peers.push({ label: t(p.labelKey), active: false, icon: p.icon });
        actions.push(() => p.onSelect());
      }
      const barH = bottomNavH(h);
      const { hits } = drawBottomNavTabs(core.bodyLayer, w, h - barH, barH, peers, (i) => actions[i]?.());
      core.hitRects.push(...hits);
      return;
    }

    const sidebarW = sidebarNavW(w, h, true);
    let y = core.headerH;

    if (core.showGroup && core.cb.peerTab) {
      const groupTabs: HubTab[] = [
        { label: t(core.cb.peerTab.labelKey), active: false, icon: core.cb.peerTab.icon },
        { label: t('equip.title'), active: true, icon: 'equipIcon' },
      ];
      const group = drawSidebarTabs(core.bodyLayer, sidebarW, y, h, groupTabs, (i) => {
        if (i === 0) core.cb.peerTab?.onSelect();
      });
      core.hitRects.push(...group.hits);
      y = group.bottom + Math.round(h * 0.03);
    }

    const sub = drawSidebarTabs(
      core.bodyLayer, sidebarW, y, h,
      EQUIP_SUBTABS.map((tab) => ({ label: t(tab.label), active: tab.key === core.activeTab, icon: tab.icon })),
      (i) => {
        const key = EQUIP_SUBTABS[i]!.key;
        if (core.activeTab !== key) { core.activeTab = key; core.scrollY = 0; core.render(); }
      },
      { sub: true },
    );
    core.hitRects.push(...sub.hits);

    // Peers after Equipment in the growth group ([Cards | Equipment | Skins]) render *below* the
    // Inventory/Craft sub-tabs, so the sub-tabs stay nested under Equipment and the trailing peer
    // (Skins) shifts down instead of disappearing — see EquipmentCallbacks.trailingPeers.
    const trailing = core.cb.trailingPeers ?? [];
    if (trailing.length > 0) {
      const ty = sub.bottom + Math.round(h * 0.03);
      const peerTabs: HubTab[] = trailing.map((p) => ({ label: t(p.labelKey), active: false, icon: p.icon }));
      const after = drawSidebarTabs(core.bodyLayer, sidebarW, ty, h, peerTabs, (i) => trailing[i]?.onSelect());
      core.hitRects.push(...after.hits);
    }
  }

  renderInventory(bodyTop: number): void {
    const core = this.core;
    const { w, h, landscape } = core;
    const save = core.cb.getSave();
    // Item cells (and the loadout strip below) start right of the sidebar rail (landscape); portrait's
    // sidebar is a bottom bar (§18), so there's no width reservation there.
    const left = landscape ? sidebarNavW(w, h, true) : 0;
    // Bag mode (no active card) has no single-card loadout to show; the list starts right below the header row.
    let listY = bodyTop;
    if (!core.bag) { renderLoadout(core, this.detail, save, bodyTop, left); listY = bodyTop + LOADOUT_H; }
    // Portrait's peer-level bottom bar (when shown) reserves bottomNavH off the bottom.
    const availH = h - listY - 8 - (!landscape && core.hasGroupNav ? bottomNavH(h) : 0);

    const instances = this.sortedInstances(save);

    if (instances.length === 0) {
      const lbl = txt(t('equip.invEmpty'), FS.heading, C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + availH / 2;
      core.bodyLayer.addChild(lbl);
      core.maxScroll = 0;
      this.lastEntrySig = [];
      this.cellContainers = new Map();
      this.cellRects = new Map();
      return;
    }

    // Sort: equipped first, then rarity desc, then level desc — stable, deterministic (see
    // sortedInstances()).
    const equippedSet = equippedIds(save);
    const entries = this.buildDisplayEntries(instances, equippedSet);
    this.lastEntrySig = this.entrySignature(entries);
    // Item cells start right of the sidebar rail; right pad stays one CELL_GAP.
    const gridLeft = left + CELL_GAP;
    const avail = w - gridLeft - CELL_GAP;
    // See equipGridColumns (EquipmentScene/layout.ts) for the column-width-floor + centering math
    // and equipmentGridColumns.test.ts for its unit coverage — 2026-08-09 UX fix.
    const { cols, cellW, offset: gridOffset } = equipGridColumns(avail, landscape);

    // Layout pass: headers span a full row and reset the column cursor; item
    // cells pack left-to-right into `cols` columns. `off` is the vertical
    // offset from listY (pre-scroll), computed up-front to clamp scrollY.
    // Items belonging to a collapsed section are skipped entirely (no space reserved).
    type Placed =
      | { kind: 'header'; label: string; key: SectionKey; off: number }
      | { kind: 'item'; inst: EquipmentInstance; isEquipped: boolean; count: number; x: number; off: number };
    const placed: Placed[] = [];
    let off = LIST_TOP_PAD;
    let col = 0;
    let collapsed = false;
    for (const entry of entries) {
      if (entry.kind === 'header') {
        if (col !== 0) { off += EQUIP_CELL_H + CELL_GAP; col = 0; }
        collapsed = core.collapsedSections.has(entry.key);
        placed.push({ kind: 'header', label: entry.label, key: entry.key, off });
        off += SECTION_H;
        continue;
      }
      if (collapsed) continue;
      const x = gridLeft + gridOffset + col * (cellW + CELL_GAP_X);
      placed.push({ kind: 'item', inst: entry.inst, isEquipped: entry.isEquipped, count: entry.count, x, off });
      col++;
      if (col >= cols) { col = 0; off += EQUIP_CELL_H + CELL_GAP; }
    }
    if (col !== 0) off += EQUIP_CELL_H + CELL_GAP;
    const totalH = off + CELL_GAP;
    // Clamp the viewport so it always cuts mid-row when there's more below — a partial next card
    // always peeks above the fold instead of the screen looking coincidentally "full".
    const listH = peekViewportH(availH, EQUIP_CELL_H + CELL_GAP, totalH);
    const maxScroll = Math.max(0, totalH - listH);
    core.scrollY = Math.max(0, Math.min(core.scrollY, maxScroll));
    core.scrollRegionTop = listY;
    core.scrollRegionBottom = listY + listH;
    core.maxScroll = maxScroll;

    // Cards are drawn into a masked sub-layer so an overscrolled row never bleeds up past listY
    // and paints over the slot filter bar / loadout strip above it (they only skip rows fully
    // outside [listY, listY+listH], so a row straddling that edge would otherwise render in full).
    const gridLayer = new PIXI.Container();
    core.bodyLayer.addChild(gridLayer);
    const clip = new PIXI.Graphics();
    clip.beginFill(0xffffff).drawRect(0, listY, w, listH).endFill();
    core.bodyLayer.addChild(clip);
    gridLayer.mask = clip;
    this.cellContainers = new Map();
    this.cellRects = new Map();
    const outerLayer = core.bodyLayer;
    core.bodyLayer = gridLayer;
    for (const p of placed) {
      const y = listY + p.off - core.scrollY;
      const eh = p.kind === 'header' ? SECTION_H : EQUIP_CELL_H;
      if (y + eh < listY || y > listY + listH) continue;
      if (p.kind === 'header') { this.renderSectionHeader(p.label, p.key, y); continue; }
      // Each item cell gets its own container (rather than drawing loose into gridLayer) so
      // refreshInstanceCell() can tear down and redraw just this one cell in place later.
      const cellC = new PIXI.Container();
      gridLayer.addChild(cellC);
      this.cellContainers.set(p.inst.id, cellC);
      this.cellRects.set(p.inst.id, { x: p.x, y, w: cellW });
      core.bodyLayer = cellC;
      renderInstanceCell(core, this.detail, p.inst, p.x, y, cellW, p.isEquipped, p.count);
      core.bodyLayer = gridLayer;
    }
    core.bodyLayer = outerLayer;

    drawScrollIndicator(core.bodyLayer, { x: gridLeft, y: listY, w: avail, h: listH }, core.scrollY, Math.max(0, totalH - listH));
  }

  /** Slot filter bar (All / Weapon / Armor / Trinket), confined to [x, x+w) — the right column. */
  renderSlotFilter(x: number, y: number, w: number): void {
    const core = this.core;
    // Batch-5 glyphs. `armor` is deliberately a BREASTPLATE, not a shield: the page title and the
    // peer tab on this very screen are already `equipIcon`'s kite shield, and `weapon` is ONE upright
    // sword so it can't be read as `pvpTabIcon`'s crossed pair. `all` (2x2 grid) is generic on
    // purpose — other pages' "All" filters can reuse it.
    const filters: { key: EquipSlot | 'all'; label: string; icon: IconKind }[] = [
      { key: 'all',     label: t('equip.filterAll'),      icon: 'allTabIcon' },
      { key: 'weapon',  label: t('equip.slot.weapon'),     icon: 'weaponTabIcon' },
      { key: 'armor',   label: t('equip.slot.armor'),      icon: 'armorslotTabIcon' },
      { key: 'trinket', label: t('equip.slot.trinket'),    icon: 'trinketTabIcon' },
    ];
    const fw = w / filters.length;
    const bg = new PIXI.Graphics();
    bg.beginFill(0xe8e5da).drawRect(x, y, w, FILTER_H).endFill();
    core.bodyLayer.addChild(bg);

    filters.forEach((f, i) => {
      const active = core.filterSlot === f.key;
      const fx = x + i * fw;
      if (active) {
        const hlt = new PIXI.Graphics();
        hlt.beginFill(0xfaf9f5).drawRoundedRect(fx + 3, y + 3, fw - 6, FILTER_H - 6, 3).endFill();
        core.bodyLayer.addChild(hlt);
      }
      const fg = active ? C.accent : C.dark;
      // [icon][gap][label] centred in the cell, same shape as HubTabs' cells (this strip is
      // hand-rolled — it isn't a HubTab). Four cells share the column, so the label scales down
      // rather than pushing the group past the cell edge (de/en labels run much longer than zh).
      const lbl = txt(f.label, FS.label, fg, active);
      const iconSize = Math.round(FILTER_H * 0.5), gapIL = 6;
      const maxLblW = fw - 8 - iconSize - gapIL;
      if (lbl.width > maxLblW) lbl.scale.set(maxLblW / lbl.width);
      const groupX = fx + Math.round((fw - (iconSize + gapIL + lbl.width)) / 2);
      const icon = buildIcon(f.icon, iconSize, fg);
      icon.x = groupX; icon.y = y + Math.round((FILTER_H - iconSize) / 2);
      core.bodyLayer.addChild(icon);
      lbl.anchor.set(0, 0.5); lbl.x = groupX + iconSize + gapIL; lbl.y = y + FILTER_H / 2;
      core.bodyLayer.addChild(lbl);
      core.hitRects.push({
        rect: { x: fx, y, w: fw, h: FILTER_H },
        fn: () => {
          if (core.filterSlot !== f.key) { core.filterSlot = f.key; core.scrollY = 0; core.render(); }
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
    const core = this.core;
    const { w } = core;
    const collapsed = core.collapsedSections.has(key);
    const left = marginLineX(w) + CELL_GAP + 20;
    const lbl = txt(`${collapsed ? '▶' : '▼'} ${label}`, FS.label, C.dark, true);
    lbl.x = left; lbl.y = cy + (SECTION_H - lbl.height) / 2;
    core.bodyLayer.addChild(lbl);
    const lineX = lbl.x + lbl.width + 10;
    const lineY = cy + SECTION_H / 2;
    const line = new PIXI.Graphics();
    line.lineStyle(1, C.mid, 0.5).moveTo(lineX, lineY).lineTo(w - 14, lineY);
    core.bodyLayer.addChild(line);
    core.hitRects.push({
      rect: { x: 0, y: cy, w, h: SECTION_H },
      fn: () => {
        if (collapsed) core.collapsedSections.delete(key);
        else core.collapsedSections.add(key);
        core.render();
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
    equippedSet: Set<string>,
  ): DisplayEntry[] {
    const entries: DisplayEntry[] = [];
    let inEquippedSection = false;
    let inBagSection = false;
    const seenStacks = new Set<string>();

    for (const inst of sorted) {
      const isEquipped = equippedSet.has(inst.id);

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
        x => !equippedSet.has(x.id) && !x.locked && x.level === 0 &&
             x.defId === inst.defId && x.rarity === inst.rarity,
      ).length;
      entries.push({ kind: 'item', inst, count, isEquipped: false });
    }

    return entries;
  }
}
