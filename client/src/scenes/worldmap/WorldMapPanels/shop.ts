// WorldMap shop panel — the SLG item-card catalog opened from the header shop button
// (2026-08-02: pulled out of the Territory Overview panel into a panel of its own).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../../render/sketchUi';
import { buildIcon } from '../../../render/icons';
import { FS } from '../../../render/fontScale';
import { HUD_H } from '../constants';
import type { SlgShopItemView } from '../../../net/WorldApiClient';
import type { IconKind } from '../../../render/icons';
import type { Constructor, WorldMapPanelsBaseCtor } from './base';

// Item-kind → card icon. Was a `private static readonly` on WorldMapPanels; a mixin's class
// expression is anonymous, so there is no class name to reach a static through — module scope
// is the direct equivalent and is what the other panel mixins already use for their constants.
const SHOP_KIND_ICON: Record<string, IconKind> = {
  troop_speedup: 'hourglass',
  resource_pack: 'coinChest',
  protection: 'armor',
  battle_pass: 'trophy',
};

export interface ShopHandlers {
  shopLabel(it: SlgShopItemView): string;
  openShopPanel(): void;
  renderShopPanel(): void;
}

export function ShopMixin<TBase extends WorldMapPanelsBaseCtor>(Base: TBase): TBase & Constructor<ShopHandlers> {
  return class extends Base {
    private loadShopItems(): void {
      if (this.ctx.shopItems.length === 0) {
        void this.ctx.cb.worldApi.getShopItems()
          .then((items) => {
            this.ctx.shopItems = items;
            if (this.ctx.shopPanelOpen) this.renderShopPanel();
          })
          .catch(() => { /* offline */ });
      }
    }

    shopLabel(it: SlgShopItemView): string {
      const eff = it.effect as Record<string, number>;
      switch (it.kind) {
        case 'troop_speedup': return t('world.shop.speedup').replace('{h}', String(Math.round((eff.duration_sec ?? 0) / 3600)));
        case 'resource_pack': return t('world.shop.resPack').replace('{n}', String(eff.each ?? 0));
        case 'protection':    return t('world.shop.shield').replace('{h}', String(Math.round((eff.duration_sec ?? 0) / 3600)));
        case 'battle_pass':   return t('world.shop.battlePass');
        default:              return it.id;
      }
    }

    /** Open the shop panel: render immediately (from whatever catalog is already cached), then
     * lazy-fetch a fresh catalog the first time (mirrors openTerritoryPanel/openReplayPanel). */
    openShopPanel(): void {
      if (!this.ctx.me?.joined) { this.showToast(t('world.needBase'), C.red); return; }
      this.ctx.shopPanelOpen = true;
      this.ctx.infoScrollY = 0;
      this.renderShopPanel();
      this.loadShopItems();
    }

    /** A single shop item as a bordered card: icon frame on the left, name + cost on the right,
     * a full-width Buy/Active band along the bottom. */
    private renderShopItemCard(layer: PIXI.Container, it: SlgShopItemView, x: number, y: number, cellW: number, cellH: number): void {
      const pad = 8;
      const cell = sketchPanel(cellW, cellH, { fill: 0xfaf9f5, border: C.accent, seed: seedFor(x, y, cellW) });
      cell.x = x; cell.y = y;
      layer.addChild(cell);

      const btnBandH = 26;
      const imgBox = cellH - pad * 2 - btnBandH - 8;
      const imgX = x + pad, imgY = y + pad;
      const frame = sketchPanel(imgBox, imgBox, { fill: 0xf0eee7, border: C.accent, seed: seedFor(x, y, imgBox) });
      frame.x = imgX; frame.y = imgY;
      layer.addChild(frame);
      const iconSize = imgBox - 12;
      const icon = buildIcon(SHOP_KIND_ICON[it.kind] ?? 'tag', iconSize, C.accent);
      icon.x = imgX + (imgBox - iconSize) / 2; icon.y = imgY + (imgBox - iconSize) / 2;
      layer.addChild(icon);

      const ax = imgX + imgBox + 10;
      const colW = x + cellW - pad - ax;
      const name = txt(this.shopLabel(it), FS.tiny, C.dark, true, colW);
      name.x = ax; name.y = imgY;
      layer.addChild(name);
      const costLbl = txt(t('world.shopCost').replace('{coins}', String(it.cost)), FS.micro, C.mid);
      costLbl.x = ax; costLbl.y = imgY + imgBox - 16;
      layer.addChild(costLbl);

      // battle_pass single-slot gate (2026-08-01 fix): server rejects a repeat buy with ALREADY_ACTIVE
      // (worldsvc/src/shop.ts); grey the band out client-side too instead of letting the player burn
      // coins on a purchase that has no additional effect.
      const owned = it.kind === 'battle_pass' && !!this.ctx.me?.hasBattlePass;
      this.panelButtonIn(
        layer, owned ? t('world.shopActive') : t('world.shopBuy'), x + pad, y + cellH - pad - btnBandH, cellW - pad * 2, btnBandH, C.accent,
        () => owned ? this.showToast(t('world.shopAlreadyActive'), C.mid) : void this.ctx.net.doBuyShopItem(it.id),
        owned,
      );
    }

    /** Render the standalone shop modal: balance line + a 2-column card grid, scrollable. */
    renderShopPanel(): void {
      if (!this.ctx.me?.joined) { this.closeModal(); return; }
      const ml = this.ctx.modalLayer;
      tearDownChildren(ml);
      this.ctx.modalBtnRects = [];

      const { w, h } = this.ctx;
      const pw = Math.min(560, w - 20);
      const ph = Math.min(h * 0.8, h - HUD_H - 16);
      const px = (w - pw) / 2;
      const py = (h - HUD_H - ph) / 2;

      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim);
      this.ctx.modalDimRect = { x: 0, y: 0, w, h };

      const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, seed: seedFor(13, 13, pw) });
      panel.x = px; panel.y = py;
      ml.addChild(panel);

      const title = txt(t('world.shopTitle'), FS.tiny, C.accent);
      title.anchor.set(0.5, 0); title.x = px + pw / 2; title.y = py + 10;
      ml.addChild(title);

      let ly = py + 40;
      if (this.ctx.cb.getCoins) {
        const balance = txt(t('world.shopBalance').replace('{coins}', String(this.ctx.cb.getCoins())), FS.tiny, C.accent);
        balance.anchor.set(0.5, 0); balance.x = px + pw / 2; balance.y = ly;
        ml.addChild(balance);
        ly += 26;
      }

      const bodyBottom = py + ph - 42;
      this.ctx.infoScrollRect = null;

      const items = this.ctx.shopItems;
      if (items.length > 0) {
        const cols = 2, gap = 12;
        const gridX = px + 14, gridW = pw - 28;
        const cellW = (gridW - gap) / cols;
        const cellH = 116;
        const rows = Math.ceil(items.length / cols);
        const listLayer = this.beginScrollList(gridX, ly, gridW, bodyBottom - ly, rows * (cellH + gap) - gap, () => this.renderShopPanel());
        const ry0 = ly - this.ctx.infoScrollY;
        items.forEach((it, i) => {
          const col = i % cols, row = Math.floor(i / cols);
          const cx = gridX + col * (cellW + gap);
          const cardY = ry0 + row * (cellH + gap);
          if (cardY + cellH >= ly && cardY <= bodyBottom) this.renderShopItemCard(listLayer, it, cx, cardY, cellW, cellH);
        });
      }

      this.panelButton(t('world.close'), px + pw / 2 - 50, py + ph - 34, 100, 28, C.dark, () => this.closeModal());
    }
  };
}
