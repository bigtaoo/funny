// Skins wardrobe tab (LOBBY_IA_REDESIGN §15): folded in from the retired CollectionScene. One section
// per character (the 6 CARD_DEFS entries, 1:1 with the skin catalogue — skinDefs.ts), each showing the
// default look plus every owned skin for that character; tapping a tile equips it (works offline, it's
// a client-sync-section write, not a server call).
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import { CARD_DEFS } from '../../game/meta/cardDefs';
import { skinsForUnitType } from '../../game/meta/skinDefs';
import type { UnitType } from '../../game/types';
import { type Constructor, type CardSceneBaseCtor, CELL_GAP } from './base';

export interface SkinsHandlers {
  renderSkinsTab(): void;
}

export function SkinsMixin<TBase extends CardSceneBaseCtor>(Base: TBase): TBase & Constructor<SkinsHandlers> {
  return class extends Base {
    renderSkinsTab(): void {
      const { w, h } = this;
      const left = sidebarNavW(w, h, this.landscape) + CELL_GAP;
      const top = this.headerH + Math.round(h * 0.02);
      const owned = this.cb.getOwnedSkins();

      let y = top;
      for (const def of Object.values(CARD_DEFS)) {
        y = this.renderSkinCharacterSection(def, left, y, w - left - CELL_GAP, owned);
        y += Math.round(h * 0.025);
      }
    }

    /** One character's section: name/portrait header + a row of look tiles (default + owned skins). Returns the y past this section. */
    private renderSkinCharacterSection(
      def: { id: string; unitType: string },
      x: number,
      y: number,
      avail: number,
      owned: string[],
    ): number {
      const unitType = def.unitType as UnitType;
      const equipped = this.cb.getEquippedSkin(unitType);
      const skins = skinsForUnitType(unitType, owned);

      const headerH = 28;
      const nameLbl = txt(t(`card.${def.id}.name` as TranslationKey), 16, C.dark, true);
      nameLbl.x = x; nameLbl.y = y;
      this.bodyLayer.addChild(nameLbl);

      const tileW = 96, tileH = 96, gap = 10;
      const tiles: Array<{ id: string | null; label: string }> = [
        { id: null, label: t('collection.default') },
        ...skins.map((id) => ({ id, label: id })),
      ];
      const cols = Math.max(1, Math.floor((avail + gap) / (tileW + gap)));
      const rows = Math.ceil(tiles.length / cols);
      const rowY = y + headerH;

      tiles.forEach((tile, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        this.renderSkinTile(tile, x + col * (tileW + gap), rowY + row * (tileH + gap), tileW, tileH, tile.id === equipped, unitType);
      });

      return rowY + rows * (tileH + gap);
    }

    private renderSkinTile(
      tile: { id: string | null; label: string },
      x: number, y: number, w: number, h: number,
      isEquipped: boolean,
      unitType: UnitType,
    ): void {
      const box = sketchPanel(w, h, {
        fill: C.paper,
        border: isEquipped ? C.green : C.line,
        width: isEquipped ? 2.4 : 1.4,
        seed: seedFor(x, y, w),
      });
      box.x = x; box.y = y;
      sketchAccentBar(box, h, isEquipped ? C.green : C.accent, seedFor(x, h, 6));
      this.bodyLayer.addChild(box);

      const icSize = Math.round(h * 0.34);
      const ic = buildIcon(tile.id === null ? 'pencils' : 'brush', icSize, isEquipped ? C.green : C.accent);
      ic.x = x + (w - icSize) / 2; ic.y = y + Math.round(h * 0.12);
      this.bodyLayer.addChild(ic);

      const name = txt(tile.label, Math.round(h * 0.13), C.dark, true);
      name.anchor.set(0.5, 0.5); name.x = x + w / 2; name.y = y + h * 0.62;
      if (name.width > w - 8) name.scale.set((w - 8) / name.width);
      this.bodyLayer.addChild(name);

      const status = txt(isEquipped ? t('collection.equipped') : t('collection.equip'),
        Math.round(h * 0.11), isEquipped ? C.green : C.gold, true);
      status.anchor.set(0.5, 0.5); status.x = x + w / 2; status.y = y + h * 0.84;
      this.bodyLayer.addChild(status);

      if (!isEquipped) {
        this.hitRects.push({
          rect: { x, y, w, h },
          action: () => { this.cb.equipSkin(unitType, tile.id); this.render(); },
        });
      }
    }
  };
}
