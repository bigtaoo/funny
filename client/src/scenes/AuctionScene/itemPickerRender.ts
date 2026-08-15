// Unified item picker (scene-level overlay): choosing what to list, reached from the create-listing
// form's item field (see createListing.ts). Lists every sellable item across all three classes
// (materials + equipment + cards + skins) in one scrollable grid, sorted by estimated value
// descending. Picking an entry returns to the create form.
//
// Plain form① functions taking `core: AuctionSceneCore` explicitly, NOT a class — split out of the
// former PickerMixin during the 2026-08-11 composition conversion. The original mixin had a genuine
// bidirectional dependency with CreateFormMixin (picker→openCreateForm, createForm→
// selectedItemLabel/openItemPicker); per the composition-priority rule that meant the file boundary
// was drawn wrong. Rather than merge into one large class (which would just reproduce the old
// >500-line god-file problem one level up), every "return to the create form" call site here goes
// through Core's `reopenCreateForm` lazy hook (the same "default no-op then overwritten by the outer
// assembly" pattern SectSceneCore's `allianceHooks` uses) instead of a direct cross-file method call —
// once that's in place, nothing here needs `this` or a sibling reference at all, so a class buys
// nothing over plain functions (see claudedocs/client-modules.md's split-form priority note: function
// module > class+composition > inheritance chain).
import * as PIXI from 'pixi.js-legacy';
import { AUCTION_STATIC_REF_PRICE } from '@nw/shared';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { drawSidebarTabs, drawBottomNavTabs, sidebarNavW, bottomNavH, type HubTab } from '../../ui/widgets/HubTabs';
import { t } from '../../i18n';
import { buildIcon, type IconKind } from '../../render/icons';
import { levelStarsText } from '../../render/levelStars';
import { buildMaterialIcon } from '../../render/atlas/materialAtlas';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import type { EquipmentInstance, CardInstance, EquipRarity } from '../../game/meta/SaveData';
import { getEquipDef, EQUIP_MAX_LEVEL } from '../../game/meta/equipmentDefs';
import { MAX_CARD_LEVEL } from '../../game/meta/cardDefs';
import { buildEquipIcon } from '../../render/atlas/equipmentAtlas';
import { cardInstanceArtUrl, getArtTexture, unitPortraitUrl } from '../../render/cardArt';
import { SKIN_TARGET_UNIT, skinDisplayName, allEquippedSkins, isKnownSkin } from '../../game/meta/skinDefs';
import { FILTERS, MATERIALS, type AucFilter } from './types';
import type { AuctionSceneCore } from './core';
import { equipName, cardName } from './itemLabels';

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
// Skins have no server reference price either (no rarity/level) — flat sort heuristic only.
const SKIN_VALUE = 800;

export interface PickEntry {
  label: string;
  value: number;
  locked: boolean;
  cls: 'material' | 'equipment' | 'card' | 'skin';
  /** Material glyph name (cls === 'material') or def id (equipment/card) used to resolve the real per-item picture. */
  material?: typeof MATERIALS[number];
  defId?: string;
  /** Skin id (cls === 'skin') — skins have no defId/instance, just a catalogue id (see skinDefs.ts). */
  skinId?: string;
  onPick: () => void;
  /**
   * Sell this skin to the system for coins (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08) — only ever
   * set for cls==='skin' entries, and only when `cb.sellSkin` is wired (present). Every skin that
   * reaches the picker at all is already sellable under the identical "not equipped, or a surplus
   * copy" guard `listableSkins()` applies for auctioning — no separate eligibility check needed here.
   */
  onSell?: () => void;
}

/** Equipment instances eligible for listing: not locked and not equipped by any card (mirrors server escrow guard). */
export function listableEquipment(core: AuctionSceneCore): EquipmentInstance[] {
  const save = core.cb.getSave?.();
  if (!save) return [];
  const equippedIds = new Set<string>();
  for (const card of Object.values(save.cardInv ?? {})) {
    for (const id of Object.values(card.gear ?? {})) if (id) equippedIds.add(id);
  }
  return Object.values(save.equipmentInv ?? {}).filter((e) => !e.locked && !equippedIds.has(e.id));
}

/** Card instances eligible for listing: gear must be empty before listing (mirrors server escrow guard, §11). */
export function listableCards(core: AuctionSceneCore): CardInstance[] {
  const save = core.cb.getSave?.();
  if (!save) return [];
  return Object.values(save.cardInv ?? {}).filter((c) => !Object.values(c.gear ?? {}).some((v) => !!v));
}

/**
 * Owned skin ids eligible for listing: a known catalogue id (a removed/placeholder SKU or any other
 * id that leaked into inventory.skins by mistake — see isKnownSkin's doc comment, 2026-08-08 — has
 * no real name/art and must never be offered), and either not currently equipped, or owned in
 * surplus (skinCounts > 1 — a duplicate gacha pull, ITEM_IDENTITY_DESIGN.md task1, 2026-08-08) —
 * mirrors the server's escrowSkin guard, which only protects the LAST remaining copy of an equipped
 * skin, not every copy. `skinCounts` may be absent on a save pulled before this field existed
 * (client-only default fills it to {} via migrate.ts, but a stale in-memory object from before a
 * reconcile could still lack it) — falls back to "exactly 1 copy" (the old behavior) in that case.
 */
export function listableSkins(core: AuctionSceneCore): string[] {
  const save = core.cb.getSave?.();
  if (!save) return [];
  const equipped = new Set(allEquippedSkins(save.equipped ?? {}));
  const counts = save.skinCounts ?? {};
  return (save.inventory?.skins ?? []).filter((id) => {
    if (!isKnownSkin(id)) return false;
    if (!equipped.has(id)) return true;
    return (counts[id] ?? 1) > 1;
  });
}

/** Label of the currently selected item (any class) for the create form, or null when none is chosen (or it is no longer listable). */
export function selectedItemLabel(core: AuctionSceneCore): string | null {
  if (core.createClass === 'material') {
    return t(`auction.${core.createMaterial}` as 'auction.scrap' | 'auction.lead' | 'auction.binding');
  }
  if (core.createClass === 'equipment') {
    const inst = listableEquipment(core).find((e) => e.id === core.createEquipId);
    if (!inst) return null;
    const stars = levelStarsText(inst.level, EQUIP_MAX_LEVEL);
    return stars ? `${equipName(inst.defId)} ${stars}` : equipName(inst.defId);
  }
  if (core.createClass === 'skin') {
    const skinId = listableSkins(core).find((id) => id === core.createSkinId);
    return skinId ? skinDisplayName(skinId) : null;
  }
  const inst = listableCards(core).find((c) => c.id === core.createCardId);
  if (!inst) return null;
  const stars = levelStarsText(inst.level, MAX_CARD_LEVEL);
  return stars ? `${cardName(inst.defId)} ${stars}` : cardName(inst.defId);
}

/** Sets the picked class/instance on core, closes the picker, re-renders, and returns to the create
 *  form via Core's `reopenCreateForm` lazy hook (wired by the outer AuctionScene assembly right after
 *  CreateListingPanel is constructed — see core.ts's file-header comment). */
function pickAndReturn(core: AuctionSceneCore, apply: () => void): void {
  apply();
  core.itemPickerOpen = false;
  core.scrollY = 0;
  core.render();
  core.reopenCreateForm();
}

/**
 * Combined pick list across all three classes, sorted by estimated value descending.
 * Equipment/card instances are grouped by defId+level: a stack of identical drops (e.g. a dozen
 * "Marker +0") would otherwise repeat the same card dozens of times. Each listing only ever escrows
 * one instance anyway (qty forced to 1 server-side), so any instance in the group is an equally
 * valid pick — the label just appends "×N" so the count isn't lost.
 */
export function buildPickEntries(core: AuctionSceneCore): PickEntry[] {
  const entries: PickEntry[] = [];
  for (const mat of MATERIALS) {
    entries.push({
      material: mat, label: t(`auction.${mat}` as 'auction.scrap' | 'auction.lead' | 'auction.binding'),
      value: AUCTION_STATIC_REF_PRICE[mat] ?? 0, locked: false, cls: 'material',
      onPick: () => pickAndReturn(core, () => { core.createClass = 'material'; core.createMaterial = mat; }),
    });
  }

  const equipGroups = new Map<string, { rep: EquipmentInstance; count: number }>();
  for (const e of listableEquipment(core)) {
    const key = `${e.defId}:${e.level}`;
    const g = equipGroups.get(key);
    if (g) g.count++; else equipGroups.set(key, { rep: e, count: 1 });
  }
  for (const { rep, count } of equipGroups.values()) {
    const stars = levelStarsText(rep.level, EQUIP_MAX_LEVEL);
    const base = stars ? `${equipName(rep.defId)} ${stars}` : equipName(rep.defId);
    entries.push({
      defId: rep.defId, label: count > 1 ? `${base} ×${count}` : base,
      value: EQUIP_VALUE_BY_RARITY[rep.rarity] ?? 0, locked: false, cls: 'equipment',
      onPick: () => pickAndReturn(core, () => { core.createClass = 'equipment'; core.createEquipId = rep.id; }),
    });
  }

  const cardGroups = new Map<string, { rep: CardInstance; count: number }>();
  for (const c of listableCards(core)) {
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
    const stars = levelStarsText(rep.level, MAX_CARD_LEVEL);
    const base = stars ? `${cardName(rep.defId)} ${stars}` : cardName(rep.defId);
    entries.push({
      defId: rep.defId, label: count > 1 ? `${base} ×${count}` : base,
      value: CARD_VALUE_BASE + (rep.level - 1) * CARD_VALUE_PER_LEVEL, locked: rep.locked, cls: 'card',
      onPick: () => pickAndReturn(core, () => { core.createClass = 'card'; core.createCardId = rep.id; }),
    });
  }

  // Skins: `inventory.skins` is still an owned/not-owned set (at most one entry per skinId here —
  // escrow/sell always take exactly one unit regardless of which instance backs it), but a
  // duplicate gacha pull can now leave a skinId with 2+ real instances (ITEM_IDENTITY_DESIGN.md
  // task1, 2026-08-08) — surfaced via skinCounts, mirrors the "×N" treatment equipment/card groups
  // get above. Every entry that reaches the picker is already sellable under the same guard as
  // listing (see listableSkins), so onSell is offered whenever the callback is wired.
  const skinCounts = core.cb.getSave?.()?.skinCounts ?? {};
  for (const skinId of listableSkins(core)) {
    const count = skinCounts[skinId] ?? 1;
    const base = skinDisplayName(skinId);
    entries.push({
      skinId, label: count > 1 ? `${base} ×${count}` : base,
      value: SKIN_VALUE, locked: false, cls: 'skin',
      onPick: () => pickAndReturn(core, () => { core.createClass = 'skin'; core.createSkinId = skinId; }),
      onSell: core.cb.sellSkin ? () => sellSkinFromPicker(core, skinId) : undefined,
    });
  }

  entries.sort((a, b) => b.value - a.value);
  return entries;
}

export function openItemPicker(core: AuctionSceneCore): void {
  core.closeModal();
  core.itemPickerOpen = true;
  core.pickerFilter = '';
  core.scrollY = 0;
  core.render();
}

/** Cancel the picker and return to the create form (keeps any prior selection). */
export function cancelItemPicker(core: AuctionSceneCore): void {
  core.itemPickerOpen = false;
  core.scrollY = 0;
  core.render();
  core.reopenCreateForm();
}

/**
 * Category rail (All/Equipment/Character-cards/Materials), mirrors the market tab's
 * renderSidebar so the picker reads consistently with the rest of the auction scene. Landscape:
 * inside the notebook-margin gutter — returns its width so the item grid starts clear of it.
 * Portrait (§18): a bottom nav bar instead — returns 0; renderItemPicker reserves `bottomNavH`
 * off the bottom of its own availH instead.
 */
function renderPickerSidebar(core: AuctionSceneCore): number {
  const { w, h, landscape } = core;
  const y = core.headerH + 8;
  const keys: Record<AucFilter, 'auction.filterAll' | 'auction.filterEquipment' | 'auction.filterCard' | 'auction.filterMaterial' | 'auction.filterSkin'> = {
    '': 'auction.filterAll', equipment: 'auction.filterEquipment', card: 'auction.filterCard', material: 'auction.filterMaterial', skin: 'auction.filterSkin',
  };
  // card/skin filters → rosterIcon/skinIcon (AI art pilot batch 2): same "卡"/"皮肤" concept the
  // [Cards|Equipment|Skins] tabs already draw with the dedicated AI art, reused here rather than the
  // generic drawn 'cards'/'brush' glyphs.
  const icons: Partial<Record<AucFilter, IconKind>> = { equipment: 'armor', card: 'rosterIcon', material: 'scrap', skin: 'skinIcon' };
  const hubTabs: HubTab[] = FILTERS.map((f) => ({ label: t(keys[f]), active: f === core.pickerFilter, icon: icons[f] }));
  const onSelect = (i: number): void => {
    const f = FILTERS[i]!;
    if (core.pickerFilter !== f) { core.pickerFilter = f; core.scrollY = 0; core.render(); }
  };
  if (!landscape) {
    const barH = bottomNavH(h);
    const { hits } = drawBottomNavTabs(core.bodyLayer, w, h - barH, barH, hubTabs, onSelect);
    for (const hit of hits) core.hitRects.push({ rect: hit.rect, action: hit.fn });
    return 0;
  }
  const sidebarW = sidebarNavW(w, h, true);
  const { hits } = drawSidebarTabs(core.bodyLayer, sidebarW, y, h, hubTabs, onSelect);
  for (const hit of hits) core.hitRects.push({ rect: hit.rect, action: hit.fn });
  return sidebarW;
}

/**
 * Real per-item picture (mirrors list.ts's renderAuctionCell): equipment gets its per-slot/rarity
 * procedural glyph, cards get the real unit art PNG, materials keep their dedicated icon glyph.
 * Centered at (cx, cy) in a `size`×`size` box.
 */
function renderPickIcon(core: AuctionSceneCore, entry: PickEntry, cx: number, cy: number, size: number, seed: number): void {
  if (entry.cls === 'equipment' && entry.defId) {
    const def = getEquipDef(entry.defId);
    if (def) {
      const icon = buildEquipIcon(entry.defId, def.slot, def.rarity, size, seed);
      icon.x = cx; icon.y = cy;
      core.bodyLayer.addChild(icon);
      return;
    }
  } else if (entry.cls === 'card' && entry.defId) {
    const artUrl = cardInstanceArtUrl({ defId: entry.defId }) ?? undefined;
    if (artUrl) {
      const tex = getArtTexture(artUrl);
      if (tex.baseTexture.valid) {
        const scale = Math.min(size / tex.width, size / tex.height);
        const sp = new PIXI.Sprite(tex);
        sp.anchor.set(0.5);
        sp.scale.set(scale);
        sp.position.set(cx, cy);
        core.bodyLayer.addChild(sp);
        return;
      }
      if (!core.artHooked.has(artUrl)) {
        core.artHooked.add(artUrl);
        tex.baseTexture.once('loaded', () => core.render());
      }
    }
  } else if (entry.cls === 'skin' && entry.skinId) {
    const unitType = SKIN_TARGET_UNIT[entry.skinId];
    const artUrl = unitType ? unitPortraitUrl(unitType, entry.skinId) ?? undefined : undefined;
    if (artUrl) {
      const tex = getArtTexture(artUrl);
      if (tex.baseTexture.valid) {
        const scale = Math.min(size / tex.width, size / tex.height);
        const sp = new PIXI.Sprite(tex);
        sp.anchor.set(0.5);
        sp.scale.set(scale);
        sp.position.set(cx, cy);
        core.bodyLayer.addChild(sp);
        return;
      }
      if (!core.artHooked.has(artUrl)) {
        core.artHooked.add(artUrl);
        tex.baseTexture.once('loaded', () => core.render());
      }
    }
    const icon = buildIcon('brush', size, C.dark);
    icon.x = cx - size / 2; icon.y = cy - size / 2;
    core.bodyLayer.addChild(icon);
    return;
  }
  if (entry.cls === 'material') {
    const icon = buildMaterialIcon(entry.material ?? 'scrap', size, C.dark);
    icon.x = cx - size / 2; icon.y = cy - size / 2;
    core.bodyLayer.addChild(icon);
    return;
  }
  const fallback: IconKind = entry.cls === 'equipment' ? 'armor' : 'cards';
  const icon = buildIcon(fallback, size, C.dark);
  icon.x = cx - size / 2; icon.y = cy - size / 2;
  core.bodyLayer.addChild(icon);
}

/** Square-ish icon card: glyph centered top, name below, lock badge top-right, tap anywhere to pick. */
function renderPickCard(core: AuctionSceneCore, entry: PickEntry, x: number, y: number, cardW: number): void {
  const card = sketchPanel(cardW, CARD_H, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(x, y, cardW) });
  card.x = x; card.y = y;
  core.bodyLayer.addChild(card);

  if (entry.locked) {
    const lk = buildIcon('lock', 20, C.mid);
    lk.x = x + cardW - 12 - 20; lk.y = y + 9;
    core.bodyLayer.addChild(lk);
  }

  renderPickIcon(core, entry, x + cardW / 2, y + 14 + 28, 56, seedFor(x, y, cardW));

  const nameLbl = txt(entry.label, FS.body, C.dark, true);
  nameLbl.anchor.set(0.5, 0); nameLbl.x = x + cardW / 2; nameLbl.y = y + 88;
  if (nameLbl.width > cardW - 18) nameLbl.scale.set((cardW - 18) / nameLbl.width);
  core.bodyLayer.addChild(nameLbl);

  // Skins with a wired sellSkin callback get a second action (ITEM_IDENTITY_DESIGN.md task1,
  // 2026-08-08): split the bottom hint row into "list on market" (left) / "sell to system" (right),
  // each with their own hit zone pushed BEFORE the full-card catch-all below so a tap on either
  // half is intercepted first (hitRects resolve in push order, first match wins — see core.handleDown).
  if (entry.onSell) {
    const half = cardW / 2;
    const auctionHint = txt(t('auction.pickHint'), FS.small, C.accent, true);
    auctionHint.anchor.set(0.5, 1); auctionHint.x = x + half / 2; auctionHint.y = y + CARD_H - 8;
    core.bodyLayer.addChild(auctionHint);
    const sellHint = txt(t('auction.sellHint'), FS.small, C.mid, true);
    sellHint.anchor.set(0.5, 1); sellHint.x = x + half + half / 2; sellHint.y = y + CARD_H - 8;
    core.bodyLayer.addChild(sellHint);
    core.hitRects.push({ rect: { x, y: y + CARD_H - 28, w: half, h: 28 }, action: entry.onPick });
    core.hitRects.push({ rect: { x: x + half, y: y + CARD_H - 28, w: half, h: 28 }, action: entry.onSell });
  } else {
    const hint = txt(t('auction.pickHint'), FS.small, C.accent, true);
    hint.anchor.set(0.5, 1); hint.x = x + cardW / 2; hint.y = y + CARD_H - 8;
    core.bodyLayer.addChild(hint);
  }

  core.hitRects.push({ rect: { x, y, w: cardW, h: CARD_H }, action: entry.onPick });
}

export function renderItemPicker(core: AuctionSceneCore): void {
  const { w, h, landscape } = core;
  const titleY = core.headerH + 8;
  const title = txt(t('auction.pickItem'), FS.tiny, C.dark, true);
  title.x = 12; title.y = titleY;
  core.bodyLayer.addChild(title);

  const contentX = renderPickerSidebar(core);
  const listY = core.headerH + 40;
  // Portrait's category rail is a bottom bar instead (§18) — reserve bottomNavH off the bottom.
  const availH = h - listY - 10 - (landscape ? 0 : bottomNavH(h));
  // Default to "nothing to scroll" — overwritten below once the real grid geometry is known;
  // covers the empty-entries early-return so a stale wheel event can't scroll a hidden grid.
  core.scrollMax = 0;

  const entries = buildPickEntries(core).filter((e) => core.pickerFilter === '' || e.cls === core.pickerFilter);
  if (entries.length === 0) {
    const lbl = txt(t('auction.noItems'), FS.tiny, C.dark);
    lbl.anchor.set(0.5, 0.5); lbl.x = contentX + (w - contentX) / 2; lbl.y = listY + availH / 2;
    core.bodyLayer.addChild(lbl);
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
  core.scrollMax = Math.max(0, totalH - availH);
  core.scrollY = Math.max(0, Math.min(core.scrollY, core.scrollMax));
  core.scrollRegionTop = listY;
  core.scrollRegionBottom = listY + availH;

  entries.forEach((entry, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = contentX + pad + col * (cardW + CARD_GAP);
    const cy = listY + row * (CARD_H + CARD_GAP) - core.scrollY;
    if (cy + CARD_H < listY || cy > listY + availH) return;
    renderPickCard(core, entry, cx, cy, cardW);
  });

  drawScrollIndicator(core.bodyLayer, { x: contentX + pad, y: listY, w: avail, h: availH }, core.scrollY, Math.max(0, totalH - availH));
}

/**
 * Sell one surplus skin instance to the system for coins (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08).
 * Guarded by `sellBusy` against a double-tap firing two concurrent sales for the same skinId before
 * the first response (and its save/picker refresh) lands.
 */
export async function sellSkinFromPicker(core: AuctionSceneCore, skinId: string): Promise<void> {
  if (core.sellBusy.has(skinId)) return;
  core.sellBusy.add(skinId);
  try {
    const { credited } = await core.cb.sellSkin!(skinId);
    await core.cb.reloadSave?.();
    core.showToast(t('auction.sellSuccess', { coins: String(credited) }));
    if (core.itemPickerOpen) core.render();
  } catch (e) {
    core.showToast(core.errorMsg(e), C.red);
  } finally {
    core.sellBusy.delete(skinId);
  }
}
