// Skins wardrobe tab (LOBBY_IA_REDESIGN §15): folded in from the retired CollectionScene. One card
// per character (the 6 CARD_DEFS entries, 1:1 with the skin catalogue — skinDefs.ts), each showing a
// portrait plus every owned look (default + skins) for that character; tapping a tile equips it (works
// offline, it's a client-sync-section write, not a server call).
//
// Layout (2026-07-15 redesign): cards packed into a scrolling multi-column masonry grid — mirrors the
// roster grid's full-height-portrait cell language (CardScene/list.ts, CARD_CELL_H/CARD_CELL_W_TARGET)
// instead of the old single-column "one row per character" list that left most of the screen width empty.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { FACTION_COLOR } from '../../render/factionIcon';
import { UNIT_ART_URLS } from '../../render/cardArt';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { CARD_DEFS, type CardDef } from '../../game/meta/cardDefs';
import { skinsForUnitType } from '../../game/meta/skinDefs';
import type { UnitType } from '../../game/types';
import { type Constructor, type CardSceneBaseCtor, CELL_GAP } from './base';

export interface SkinsHandlers {
  renderSkinsTab(): void;
}

// Wardrobe card grid constants — sized to sit alongside the roster grid's CARD_CELL_W_TARGET (300)
// while being wide enough to hold a portrait + a row of skin tiles side by side.
// Cards are 1.5x taller than the original cut (2026-07-15 follow-up); CARD_W_TARGET is sized to fit
// exactly a 2-tile row (default look + one skin, the common case) instead of a wide target that left
// most of the card blank once the tile row wrapped.
const CARD_W_TARGET = 440;
const CARD_PAD = 18;
const PORTRAIT_MAX_H = 225;
const PORTRAIT_RATIO = 0.72; // matches the roster cell's tall-portrait framing (see roster-card-fullheight-portrait memory)
const PORTRAIT_TILE_GAP = 14;
const HEADER_H = 44;
const TILE_W = 108, TILE_H = 108, TILE_GAP = 10;

export function SkinsMixin<TBase extends CardSceneBaseCtor>(Base: TBase): TBase & Constructor<SkinsHandlers> {
  return class extends Base {
    renderSkinsTab(): void {
      const { w, h } = this;
      const left = sidebarNavW(w, h, this.landscape) + CELL_GAP;
      const listY = this.headerH;
      const availH = h - listY - 8;
      const avail = w - left - CELL_GAP;

      const owned = this.cb.getOwnedSkins();
      const defs = Object.values(CARD_DEFS);
      const cols = Math.max(1, Math.floor((avail + CELL_GAP) / (CARD_W_TARGET + CELL_GAP)));
      // Clamp cellW near CARD_W_TARGET instead of stretching cards to fill the row —
      // dividing avail evenly across cols left wide blank margins next to the (fixed-size)
      // portrait + tile content once cardW exceeded what the content actually needed.
      const cellW = Math.min((avail - CELL_GAP * (cols - 1)) / cols, CARD_W_TARGET * 1.15);

      // Masonry: each character card can be a different height (more skins → more tile rows), so
      // columns are packed independently — every card goes into whichever column is currently shortest.
      // No PIXI mask backs this grid (draw-cull only, see renderSkinCard) — a card is either drawn in
      // full or skipped entirely, never cropped, so the cull/clamp/indicator use the naive `availH`
      // rather than a peekViewportH-shrunk value (that shrink is for masked grids; here it would just
      // exclude a card that'd otherwise render in full, see the roster-grid fix in list.ts).
      const colY = new Array(cols).fill(listY + CELL_GAP);

      for (const def of defs) {
        const col = colY.indexOf(Math.min(...colY));
        const x = left + col * (cellW + CELL_GAP);
        const y = colY[col];
        const cardH = this.renderSkinCard(def, x, y, cellW, owned, listY, availH);
        colY[col] = y + cardH + CELL_GAP;
      }

      const totalH = Math.max(...colY) - listY;
      const maxScroll = Math.max(0, totalH - availH);
      this.scrollY = Math.max(0, Math.min(this.scrollY, maxScroll));
      this.scrollRegionTop = listY;
      this.scrollRegionBottom = listY + availH;
      this.maxScroll = maxScroll;
      drawScrollIndicator(this.bodyLayer, { x: left, y: listY, w: avail, h: availH }, this.scrollY, maxScroll);
    }

    /** One character's wardrobe card: portrait + name on the left header, skin tiles wrapped to the right. Returns the card's height. */
    private renderSkinCard(
      def: CardDef,
      x: number,
      yUnscrolled: number,
      cardW: number,
      owned: string[],
      viewTop: number,
      viewH: number,
    ): number {
      const unitType = def.unitType as UnitType;
      const equipped = this.cb.getEquippedSkin(unitType);
      const skins = skinsForUnitType(unitType, owned);
      const tiles: Array<{ id: string | null; label: string }> = [
        { id: null, label: t('collection.default') },
        ...skins.map((id) => ({ id, label: id })),
      ];

      const portraitW = Math.round(PORTRAIT_MAX_H * PORTRAIT_RATIO);
      const tileAreaX = x + CARD_PAD + portraitW + PORTRAIT_TILE_GAP;
      const tileAreaW = cardW - CARD_PAD * 2 - portraitW - PORTRAIT_TILE_GAP;
      const tilesPerRow = Math.max(1, Math.floor((tileAreaW + TILE_GAP) / (TILE_W + TILE_GAP)));
      const rows = Math.ceil(tiles.length / tilesPerRow);
      const tileAreaH = rows * (TILE_H + TILE_GAP) - TILE_GAP;
      const cardH = Math.max(PORTRAIT_MAX_H, HEADER_H + tileAreaH) + CARD_PAD * 2;

      const y = yUnscrolled - this.scrollY;
      // Skip drawing entirely when scrolled fully off-screen — same "no mask, just skip" pattern as renderList.
      if (y + cardH < viewTop || y > viewTop + viewH) return cardH;

      const card = sketchPanel(cardW, cardH, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(x, y, cardW) });
      card.x = x; card.y = y;
      this.bodyLayer.addChild(card);

      // ── Left: portrait (capped height so a many-skin card doesn't stretch the art) ──
      const portraitH = Math.min(cardH - CARD_PAD * 2, PORTRAIT_MAX_H);
      const frame = sketchPanel(portraitW, portraitH, { fill: 0xf0eee7, border: C.mid, seed: seedFor(x, y, portraitW) });
      frame.x = x + CARD_PAD; frame.y = y + CARD_PAD;
      this.bodyLayer.addChild(frame);
      const artUrl = UNIT_ART_URLS[def.unitType as UnitType];
      if (artUrl) this.drawArtFit(artUrl, x + CARD_PAD + 2, y + CARD_PAD + 2, portraitW - 4, this.bodyLayer, portraitH - 4);

      // ── Right: name header (faction dot + name) + wrapped skin tile grid ──
      // Plain dot, not the full totem — too small to read the emblem; colour conveys faction.
      const dot = new PIXI.Graphics();
      dot.beginFill(FACTION_COLOR[def.faction]).drawCircle(0, 0, 5).endFill();
      dot.x = tileAreaX + 5; dot.y = y + CARD_PAD + 9;
      this.bodyLayer.addChild(dot);

      const nameLbl = txt(t(`card.${def.id}.name` as TranslationKey), FS.body, C.dark, true);
      nameLbl.x = tileAreaX + 16; nameLbl.y = y + CARD_PAD;
      if (nameLbl.width > tileAreaW - 16) nameLbl.scale.set((tileAreaW - 16) / nameLbl.width);
      this.bodyLayer.addChild(nameLbl);

      const tileTop = y + CARD_PAD + HEADER_H;
      tiles.forEach((tile, i) => {
        const col = i % tilesPerRow;
        const row = Math.floor(i / tilesPerRow);
        this.renderSkinTile(
          tile,
          tileAreaX + col * (TILE_W + TILE_GAP),
          tileTop + row * (TILE_H + TILE_GAP),
          TILE_W, TILE_H,
          tile.id === equipped,
          unitType,
        );
      });

      return cardH;
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

      const name = txt(tile.label, snapFont(Math.round(h * 0.13)), C.dark, true);
      name.anchor.set(0.5, 0.5); name.x = x + w / 2; name.y = y + h * 0.62;
      if (name.width > w - 8) name.scale.set((w - 8) / name.width);
      this.bodyLayer.addChild(name);

      const status = txt(isEquipped ? t('collection.equipped') : t('collection.equip'),
        snapFont(Math.round(h * 0.11)), isEquipped ? C.green : C.gold, true);
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
