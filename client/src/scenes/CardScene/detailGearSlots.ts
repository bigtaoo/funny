// The 3 gear-slot boxes (icon + level stars) inside the card detail modal — split out of detail.ts
// (2026-08-31) purely to keep that file under the 500-line convention; still only ever called from
// DetailPanel.openDetail, so it takes the same core/card/geometry/save it used to read off `this`.
import { t, type TranslationKey } from '../../i18n';
import { ui as C, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { buildLevelStars } from '../../render/levelStars';
import { buildEquipIcon } from '../../render/atlas/equipmentAtlas';
import { RARITY_COLOR } from '../EquipmentScene/layout';
import type { SaveData, CardInstance, EquipSlot } from '../../game/meta/SaveData';
import type { CardSceneCore } from './core';

/** Render 3 gear slot boxes (icon + level stars) inside the detail modal. */
export function renderDetailGearSlots(
  core: CardSceneCore,
  card: CardInstance,
  mx: number,
  cy: number,
  mw: number,
  save: SaveData,
): void {
  const EQUIP_SLOTS: EquipSlot[] = ['weapon', 'armor', 'trinket'];
  const cellW = (mw - 24 - 8 * 2) / 3;
  const cellH = 74;
  // Level used to show as a "+N" text badge in the corner; now a row of gold stars
  // (roster feedback 2026-08-30) — matches the roster grid / this modal's own header /
  // fuse-ring convention (list.ts / this file's stat-column stars / feedRing.ts). The
  // star row takes the top band the badge used to occupy, so the icon shifts down by
  // the same amount it shrinks by, keeping its bottom edge flush with the old layout.
  const starSize = 8;
  const starTopPad = 6;
  const iconTopPad = starTopPad + starSize + 2;
  const iconSize = Math.min(cellW, cellH) - 26 - (starSize + 2);
  const root = core.modalPanelRoot;

  EQUIP_SLOTS.forEach((slot, i) => {
    const x = mx + 12 + i * (cellW + 8);
    const instId = card.gear[slot];
    const inst = instId ? save.equipmentInv?.[instId] : undefined;
    const cell = sketchPanel(cellW, cellH, { fill: 0xf0eeea, border: inst ? RARITY_COLOR[inst.rarity] : C.mid, seed: seedFor(i, 8, cellW) });
    cell.x = x; cell.y = cy;
    root.addChild(cell);

    const iconCx = x + cellW / 2;
    const iconCy = cy + iconTopPad + iconSize / 2;
    // buildEquipIcon already renders the hollow "+" placeholder for an empty
    // slot, so it doesn't need dimming (a dimmed real-item glyph used to read
    // as a low-rarity equipped item at a glance).
    const icon = buildEquipIcon(inst?.defId, slot, inst?.rarity ?? 'common', iconSize, seedFor(i, 8, cellW));
    icon.position.set(iconCx, iconCy);
    icon.name = `detailGearIcon:${slot}`; // test hook: see cardDetailGearSlotStars.ui.ts
    root.addChild(icon);

    const slotLbl = core.stxt(t(`equip.slot.${slot}` as TranslationKey), FS.micro, inst ? C.mid : C.light);
    slotLbl.anchor.set(0.5, 0); slotLbl.x = iconCx; slotLbl.y = cy + cellH - 16;
    root.addChild(slotLbl);

    if (inst && inst.level > 0) {
      const { container: stars } = buildLevelStars(inst.level, cellW - 8, starSize, 1);
      stars.x = iconCx - stars.width / 2; stars.y = cy + starTopPad;
      stars.name = `gearLevelStars:${slot}`; // test hook: see cardDetailGearSlotStars.ui.ts
      root.addChild(stars);
    }

    if (core.cb.openEquipment && !core.bt.busy) {
      core.modalHits.push({
        rect: core.toModalScreen({ x, y: cy, w: cellW, h: cellH }),
        // Deliberately does NOT close the modal first (ADR-072): EquipmentScene now mounts as an
        // overlay over this still-live roster, so leaving the detail open means backing out of the
        // gear screen lands the player right back on the same card — with the new piece already
        // shown, since the roster stayed subscribed to the save through the detour. Closing it here
        // (as this used to) would have made "equip three pieces" three round trips through the grid.
        fn: () => core.cb.openEquipment!(card.id, slot),
      });
    }
  });
}
