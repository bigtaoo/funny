// WorldMap shop panel — the SLG item-card catalog opened from the header shop button
// (2026-08-02: pulled out of the Territory Overview panel into a panel of its own).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../../i18n';
import {
  ui as C,
  txt,
  txtOutlined,
  sketchPanel,
  seedFor,
  tearDownChildren,
} from '../../../render/sketchUi';
import { buildIcon } from '../../../render/icons';
import { FS } from '../../../render/fontScale';
import { HUD_H } from '../logic/constants';
import {
  PANEL_W,
  PANEL_MARGIN,
  PANEL_PAD,
  PANEL_BTN_H,
  PANEL_BTN_FONT,
  PANEL_CLOSE_W,
  PANEL_FOOTER_H,
  drawPanelTitle,
} from './spec';
import type { SlgShopItemView } from '../../../net/WorldApiClient';
import type { IconKind } from '../../../render/icons';
import type { WorldMapPanelsCore } from './core';

// Item-kind → card icon, for kinds with exactly one visual (no duration tiers). Was a
// `private static readonly` on WorldMapPanels; a mixin's class expression is anonymous, so
// there is no class name to reach a static through — module scope is the direct equivalent
// and is what the other panel mixins already use for their constants.
const SHOP_KIND_ICON: Record<string, IconKind> = {
  resource_pack: 'coinChest',
  battle_pass: 'trophy',
};

// Escalating icon variants for the two duration-tiered kinds — same idiom `currency.ts` uses
// for the coin recharge ladder (coin→coins→coinStack→coinSack→coinChest): the longer tier reads
// as a visually "fuller"/"heavier" glyph, not the same icon carrying only a text-label difference.
const SPEEDUP_ICON_TIERS: IconKind[] = ['hourglassSm', 'hourglassMd', 'hourglassLg'];
const PROTECTION_ICON_TIERS: IconKind[] = ['armor', 'armorHeavy'];

export interface ShopHandlers {
  shopLabel(it: SlgShopItemView): string;
  openShopPanel(): void;
  renderShopPanel(): void;
}

export class ShopPanel implements ShopHandlers {
  constructor(private readonly core: WorldMapPanelsCore) {}

  private loadShopItems(): void {
    if (this.core.ctx.shopItems.length === 0) {
      void this.core.ctx.cb.worldApi
        .getShopItems()
        .then((items) => {
          this.core.ctx.shopItems = items;
          if (this.core.ctx.shopPanelOpen) this.renderShopPanel();
        })
        .catch(() => {
          /* offline */
        });
    }
  }

  /**
   * Short corner-badge text for tiers that share one icon glyph across kind (troop_speedup /
   * protection both key off `duration_sec`, so a 1h/8h/24h speedup or an 8h/24h shield look
   * identical at a glance without this) — `null` for kinds with no duration tier (resource_pack
   * reads its quantity straight off the name text; battle_pass has only one tier).
   */
  private shopBadgeLabel(it: SlgShopItemView): string | null {
    if (it.kind !== 'troop_speedup' && it.kind !== 'protection') return null;
    const eff = it.effect as Record<string, number>;
    return `${Math.round((eff.duration_sec ?? 0) / 3600)}H`;
  }

  /**
   * Card icon for `it`: kinds with duration tiers (troop_speedup/protection) rank `it` among
   * same-kind items by `duration_sec` and index into that kind's escalating icon ladder, so
   * 1h/8h/24h speedup or 8h/24h shield don't share one identical glyph; other kinds use the
   * flat `SHOP_KIND_ICON` lookup.
   */
  private shopIcon(it: SlgShopItemView): IconKind {
    const tiers =
      it.kind === 'troop_speedup'
        ? SPEEDUP_ICON_TIERS
        : it.kind === 'protection'
        ? PROTECTION_ICON_TIERS
        : null;
    if (!tiers) return SHOP_KIND_ICON[it.kind] ?? 'tag';
    const sameKind = this.core.ctx.shopItems
      .filter((x) => x.kind === it.kind)
      .sort(
        (a, b) =>
          ((a.effect as Record<string, number>).duration_sec ?? 0) -
          ((b.effect as Record<string, number>).duration_sec ?? 0)
      );
    const rank = Math.max(
      0,
      sameKind.findIndex((x) => x.id === it.id)
    );
    return tiers[Math.min(rank, tiers.length - 1)] as IconKind;
  }

  shopLabel(it: SlgShopItemView): string {
    const eff = it.effect as Record<string, number>;
    switch (it.kind) {
      case 'troop_speedup':
        return t('world.shop.speedup').replace(
          '{h}',
          String(Math.round((eff.duration_sec ?? 0) / 3600))
        );
      case 'resource_pack':
        return t('world.shop.resPack').replace('{n}', String(eff.each ?? 0));
      case 'protection':
        return t('world.shop.shield').replace(
          '{h}',
          String(Math.round((eff.duration_sec ?? 0) / 3600))
        );
      case 'battle_pass':
        return t('world.shop.battlePass');
      default:
        return it.id;
    }
  }

  /** Open the shop panel: render immediately (from whatever catalog is already cached), then
   * lazy-fetch a fresh catalog the first time (mirrors openTerritoryPanel/openReplayPanel). */
  openShopPanel(): void {
    if (!this.core.ctx.me?.joined) {
      this.core.showToast(t('world.needBase'), C.red);
      return;
    }
    this.core.ctx.shopPanelOpen = true;
    this.core.ctx.infoScrollY = 0;
    this.renderShopPanel();
    this.loadShopItems();
  }

  /** A single shop item as a bordered card: icon frame on the left, name + cost on the right,
   * a full-width Buy/Active band along the bottom. */
  private renderShopItemCard(
    layer: PIXI.Container,
    it: SlgShopItemView,
    x: number,
    y: number,
    cellW: number,
    cellH: number
  ): void {
    const pad = PANEL_PAD;
    const cell = sketchPanel(cellW, cellH, {
      fill: 0xfaf9f5,
      border: C.accent,
      seed: seedFor(x, y, cellW),
    });
    cell.x = x;
    cell.y = y;
    layer.addChild(cell);

    const btnBandH = PANEL_BTN_H;
    const imgBox = cellH - pad * 2 - btnBandH - 8;
    const imgX = x + pad,
      imgY = y + pad;
    // fillAlpha: 0 — see CardScene/list.ts's renderCardCell (2026-08-21): the cell behind already
    // fills+borders in this same accent color, so this frame's own fill only duplicated it.
    const frame = sketchPanel(imgBox, imgBox, {
      fill: 0xf0eee7,
      fillAlpha: 0,
      border: C.accent,
      seed: seedFor(x, y, imgBox),
    });
    frame.x = imgX;
    frame.y = imgY;
    layer.addChild(frame);
    const iconSize = imgBox - 16;
    const icon = buildIcon(this.shopIcon(it), iconSize, C.accent);
    icon.x = imgX + (imgBox - iconSize) / 2;
    icon.y = imgY + (imgBox - iconSize) / 2;
    layer.addChild(icon);

    // Duration badge — a corner tag over the frame so same-kind tiers (1h/8h/24h speedup,
    // 8h/24h shield) read apart by icon alone, not just by the name text beside it.
    const badgeLabel = this.shopBadgeLabel(it);
    if (badgeLabel) {
      const badge = txtOutlined(badgeLabel, FS.small, C.accent, 0xfaf9f5, 3, true);
      badge.anchor.set(1, 0);
      badge.x = imgX + imgBox + 4;
      badge.y = imgY - 8;
      layer.addChild(badge);
    }

    const ax = imgX + imgBox + 14;
    const colW = x + cellW - pad - ax;
    const name = txt(this.shopLabel(it), FS.bodyLg, C.dark, true, colW);
    name.x = ax;
    name.y = imgY;
    layer.addChild(name);
    const costLbl = txt(t('world.shopCost').replace('{coins}', String(it.cost)), FS.body, C.mid);
    // German's item names ("Truppen-Beschleunigung 24 Std") wrap to 3 lines in this column and
    // would otherwise run into the cost line pinned to the icon box's bottom edge — shrink the
    // wrapped block to whatever room is left above it (same shrink-to-fit idiom the header
    // production readout and the HUD stat chips use).
    const nameMaxH = imgBox - costLbl.height - 6;
    if (name.height > nameMaxH) name.scale.set(nameMaxH / name.height);
    costLbl.x = ax;
    costLbl.y = imgY + imgBox - costLbl.height;
    layer.addChild(costLbl);

    // battle_pass single-slot gate (2026-08-01 fix): server rejects a repeat buy with ALREADY_ACTIVE
    // (worldsvc/src/shop.ts); grey the band out client-side too instead of letting the player burn
    // coins on a purchase that has no additional effect.
    const owned = it.kind === 'battle_pass' && !!this.core.ctx.me?.hasBattlePass;
    this.core.panelButtonIn(
      layer,
      owned ? t('world.shopActive') : t('world.shopBuy'),
      x + pad,
      y + cellH - pad - btnBandH,
      cellW - pad * 2,
      btnBandH,
      C.accent,
      () =>
        owned
          ? this.core.showToast(t('world.shopAlreadyActive'), C.mid)
          : void this.core.ctx.net.doBuyShopItem(it.id),
      owned
    );
  }

  /** Render the standalone shop modal: balance line + a 2-column card grid, scrollable. */
  renderShopPanel(): void {
    if (!this.core.ctx.me?.joined) {
      this.core.closeModal();
      return;
    }
    const ml = this.core.ctx.modalLayer;
    tearDownChildren(ml);
    this.core.ctx.modalBtnRects = [];

    const { w, h } = this.core.ctx;
    const pw = Math.min(PANEL_W.md, w - PANEL_MARGIN * 2);
    const ph = Math.min(h * 0.8, h - HUD_H - 16);
    const px = (w - pw) / 2;
    const py = (h - HUD_H - ph) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.core.ctx.modalDimRect = { x: 0, y: 0, w, h };

    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, seed: seedFor(13, 13, pw) });
    panel.x = px;
    panel.y = py;
    ml.addChild(panel);

    let ly = drawPanelTitle(ml, t('world.shopTitle'), px, py, pw);

    // Coin balance as the game's one coin readout: glyph + gold bold number, no "coins" word —
    // the same cluster `drawHeaderCurrency` draws in every spend scene (see
    // ui/widgets/SceneHeader/currency.ts `buildCluster`: "the glyph is the unit"). It used to be
    // a grey `t('world.shopBalance')` sentence, which was the only place in the game a balance
    // was spelled out in words. Hand-built rather than calling drawHeaderCurrency because that
    // one right-anchors itself to a full-width header bar; here it is centred inside a panel.
    if (this.core.ctx.cb.getCoins) {
      const coinSize = 32;
      const amount = txt(this.core.ctx.cb.getCoins().toLocaleString(), FS.heading, C.gold, true);
      const rowW = coinSize + 8 + amount.width;
      const rowX = px + (pw - rowW) / 2;
      const coin = buildIcon('coin', coinSize, C.gold);
      coin.x = rowX;
      coin.y = ly;
      ml.addChild(coin);
      amount.anchor.set(0, 0.5);
      amount.x = rowX + coinSize + 8;
      amount.y = ly + coinSize / 2;
      ml.addChild(amount);
      ly += coinSize + PANEL_PAD;
    }

    const bodyBottom = py + ph - PANEL_FOOTER_H;
    this.core.ctx.infoScrollRect = null;

    const items = this.core.ctx.shopItems;
    if (items.length > 0) {
      const cols = 2,
        gap = 16;
      const gridX = px + PANEL_PAD,
        gridW = pw - PANEL_PAD * 2;
      const cellW = (gridW - gap) / cols;
      // pad*2 + icon box + 8 + the button band: sized off PANEL_BTN_H so the Buy band and the
      // icon square stay in proportion if the shared button height is ever re-tuned.
      const cellH = PANEL_PAD * 2 + 100 + 8 + PANEL_BTN_H;
      const rows = Math.ceil(items.length / cols);
      const listLayer = this.core.beginScrollList(
        gridX,
        ly,
        gridW,
        bodyBottom - ly,
        rows * (cellH + gap) - gap,
        () => this.renderShopPanel()
      );
      const ry0 = ly - this.core.ctx.infoScrollY;
      items.forEach((it, i) => {
        const col = i % cols,
          row = Math.floor(i / cols);
        const cx = gridX + col * (cellW + gap);
        const cardY = ry0 + row * (cellH + gap);
        if (cardY + cellH >= ly && cardY <= bodyBottom)
          this.renderShopItemCard(listLayer, it, cx, cardY, cellW, cellH);
      });
    }

    this.core.panelButton(
      t('world.close'),
      px + (pw - PANEL_CLOSE_W) / 2,
      py + ph - PANEL_BTN_H - PANEL_PAD / 2,
      PANEL_CLOSE_W,
      PANEL_BTN_H,
      C.dark,
      () => this.core.closeModal()
    );
  }
}
