// Skins wardrobe tab (LOBBY_IA_REDESIGN §15): folded in from the retired CollectionScene. One card
// per character (the 6 CARD_DEFS entries, 1:1 with the skin catalogue — skinDefs.ts), each showing a
// portrait plus every owned look (default + skins) for that character; tapping a tile equips it (works
// offline, it's a client-sync-section write, not a server call). Depends only on Core.
//
// Layout (2026-07-15 redesign): cards packed into a scrolling multi-column masonry grid — mirrors the
// roster grid's full-height-portrait cell language (CardScene/list.ts, CARD_CELL_H/CARD_CELL_W_TARGET)
// instead of the old single-column "one row per character" list that left most of the screen width empty.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor, marginLineX } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { FACTION_COLOR } from '../../render/factionIcon';
import { unitPortraitUrl } from '../../render/cardArt';
import { sidebarNavW, bottomNavH } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { CARD_DEFS, type CardDef } from '../../game/meta/cardDefs';
import { skinsForUnitType, skinDisplayName } from '../../game/meta/skinDefs';
import type { UnitType } from '@nw/engine/types';
import { CardSceneCore, CELL_GAP } from './core';

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

/** Skins wardrobe domain (see ../CardScene.ts assembly + ./core.ts for the shared state). */
export class SkinsPanel {
  constructor(private readonly core: CardSceneCore) {}

  renderSkinsTab(): void {
    const core = this.core;
    const { w, h, landscape } = core;
    // Portrait's sidebar nav is a bottom bar instead (§18): no width reservation, but availH
    // stops bottomNavH short of the screen (this tab's sidebar always shows, so this always applies).
    const left = (landscape ? sidebarNavW(w, h, true) : marginLineX(w)) + CELL_GAP;
    const listY = core.headerH;
    const availH = h - listY - 8 - (landscape ? 0 : bottomNavH(h));
    const avail = w - left - CELL_GAP;

    const owned = core.cb.getOwnedSkins();
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
    //
    // Packed in a measure-only pass first, then drawn — the clamp below has to land BEFORE anything
    // is culled against scrollY. It used to run after the draw loop, so a scrollY carried in from
    // somewhere with a taller extent (a scrolled roster, pre-2026-08-27 tab switch; a resize that
    // shrinks the grid) culled every card and painted a blank page, correcting itself only on the
    // NEXT render — which is exactly the "blank until you switch tabs and come back" report.
    const colY = new Array(cols).fill(listY + CELL_GAP);
    const placed: Array<{ def: CardDef; x: number; y: number; h: number }> = [];
    for (const def of defs) {
      const col = colY.indexOf(Math.min(...colY));
      const x = left + col * (cellW + CELL_GAP);
      const y = colY[col];
      const h = this.measureSkinCard(def, cellW, owned);
      placed.push({ def, x, y, h });
      colY[col] = y + h + CELL_GAP;
    }

    const totalH = Math.max(...colY) - listY;
    const maxScroll = Math.max(0, totalH - availH);
    core.scrollY = Math.max(0, Math.min(core.scrollY, maxScroll));
    core.scrollRegionTop = listY;
    core.scrollRegionBottom = listY + availH;
    core.maxScroll = maxScroll;

    for (const p of placed) this.renderSkinCard(p.def, p.x, p.y, cellW, p.h, owned, listY, availH);
    drawScrollIndicator(core.bodyLayer, { x: left, y: listY, w: avail, h: availH }, core.scrollY, maxScroll);
  }

  /**
   * One character's wardrobe-card geometry, without drawing any of it: the tile list, the tile-grid
   * wrap and the resulting card height. Split out of renderSkinCard so the masonry can be packed
   * (and scrollY clamped to the real extent) before the first card is drawn — see renderSkinsTab.
   */
  private measureSkinCard(def: CardDef, cardW: number, owned: string[]): number {
    return this.cardMetrics(def, cardW, owned).cardH;
  }

  private cardMetrics(def: CardDef, cardW: number, owned: string[]): {
    tiles: Array<{ id: string | null; label: string }>;
    portraitW: number;
    tileAreaW: number;
    tilesPerRow: number;
    cardH: number;
  } {
    const unitType = def.unitType as UnitType;
    const skins = skinsForUnitType(unitType, owned);
    const tiles: Array<{ id: string | null; label: string }> = [
      { id: null, label: t('collection.default') },
      ...skins.map((id) => ({ id, label: skinDisplayName(id) })),
    ];
    const portraitW = Math.round(PORTRAIT_MAX_H * PORTRAIT_RATIO);
    const tileAreaW = cardW - CARD_PAD * 2 - portraitW - PORTRAIT_TILE_GAP;
    const tilesPerRow = Math.max(1, Math.floor((tileAreaW + TILE_GAP) / (TILE_W + TILE_GAP)));
    const rows = Math.ceil(tiles.length / tilesPerRow);
    const tileAreaH = rows * (TILE_H + TILE_GAP) - TILE_GAP;
    const cardH = Math.max(PORTRAIT_MAX_H, HEADER_H + tileAreaH) + CARD_PAD * 2;
    return { tiles, portraitW, tileAreaW, tilesPerRow, cardH };
  }

  /** One character's wardrobe card: portrait + name on the left header, skin tiles wrapped to the right. */
  private renderSkinCard(
    def: CardDef,
    x: number,
    yUnscrolled: number,
    cardW: number,
    cardH: number,
    owned: string[],
    viewTop: number,
    viewH: number,
  ): void {
    const core = this.core;
    const unitType = def.unitType as UnitType;
    const equipped = core.cb.getEquippedSkin(unitType);
    const { tiles, portraitW, tileAreaW, tilesPerRow } = this.cardMetrics(def, cardW, owned);
    const tileAreaX = x + CARD_PAD + portraitW + PORTRAIT_TILE_GAP;

    const y = yUnscrolled - core.scrollY;
    // Skip drawing entirely when scrolled fully off-screen — same "no mask, just skip" pattern as renderList.
    if (y + cardH < viewTop || y > viewTop + viewH) return;

    const card = sketchPanel(cardW, cardH, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(x, y, cardW) });
    card.x = x; card.y = y;
    core.bodyLayer.addChild(card);

    // ── Left: portrait (capped height so a many-skin card doesn't stretch the art) ──
    const portraitH = Math.min(cardH - CARD_PAD * 2, PORTRAIT_MAX_H);
    // fillAlpha: 0 — see list.ts's renderCardCell (2026-08-21): the card behind is already the one
    // background layer, this frame is a stroke-only outline.
    const frame = sketchPanel(portraitW, portraitH, { fill: 0xf0eee7, fillAlpha: 0, border: C.mid, seed: seedFor(x, y, portraitW) });
    frame.x = x + CARD_PAD; frame.y = y + CARD_PAD;
    core.bodyLayer.addChild(frame);
    const artUrl = unitPortraitUrl(unitType, equipped);
    if (artUrl) core.drawArtFit(artUrl, x + CARD_PAD + 2, y + CARD_PAD + 2, portraitW - 4, core.bodyLayer, portraitH - 4);

    // ── Right: name header (faction dot + name) + wrapped skin tile grid ──
    // Plain dot, not the full totem — too small to read the emblem; colour conveys faction.
    const dot = new PIXI.Graphics();
    dot.beginFill(FACTION_COLOR[def.faction]).drawCircle(0, 0, 5).endFill();
    dot.x = tileAreaX + 5; dot.y = y + CARD_PAD + 9;
    core.bodyLayer.addChild(dot);

    const nameLbl = txt(t(`card.${def.id}.name` as TranslationKey), FS.body, C.dark, true);
    nameLbl.x = tileAreaX + 16; nameLbl.y = y + CARD_PAD;
    if (nameLbl.width > tileAreaW - 16) nameLbl.scale.set((tileAreaW - 16) / nameLbl.width);
    core.bodyLayer.addChild(nameLbl);

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
  }

  private renderSkinTile(
    tile: { id: string | null; label: string },
    x: number, y: number, w: number, h: number,
    isEquipped: boolean,
    unitType: UnitType,
  ): void {
    const core = this.core;
    const box = sketchPanel(w, h, {
      fill: C.paper,
      border: isEquipped ? C.green : C.line,
      width: isEquipped ? 2.4 : 1.4,
      seed: seedFor(x, y, w),
    });
    box.x = x; box.y = y;
    sketchAccentBar(box, h, isEquipped ? C.green : C.accent, seedFor(x, h, 6));
    core.bodyLayer.addChild(box);

    const icSize = Math.round(h * 0.34);
    const ic = buildIcon(tile.id === null ? 'pencils' : 'brush', icSize, isEquipped ? C.green : C.accent);
    ic.x = x + (w - icSize) / 2; ic.y = y + Math.round(h * 0.12);
    core.bodyLayer.addChild(ic);

    const name = txt(tile.label, snapFont(Math.round(h * 0.13)), C.dark, true);
    name.anchor.set(0.5, 0.5); name.x = x + w / 2; name.y = y + h * 0.62;
    if (name.width > w - 8) name.scale.set((w - 8) / name.width);
    core.bodyLayer.addChild(name);

    const status = txt(isEquipped ? t('collection.equipped') : t('collection.equip'),
      snapFont(Math.round(h * 0.11)), isEquipped ? C.green : C.gold, true);
    status.anchor.set(0.5, 0.5); status.x = x + w / 2; status.y = y + h * 0.84;
    core.bodyLayer.addChild(status);

    if (!isEquipped) {
      core.hitRects.push({
        rect: { x, y, w, h },
        action: () => { core.cb.equipSkin(unitType, tile.id); core.render(); },
      });
    }
  }
}
