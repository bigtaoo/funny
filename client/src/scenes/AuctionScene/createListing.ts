// Create-listing modal: unified item field (tap → itemPickerRender.ts's picker, across
// material/equipment/card/skin), sale-mode toggle, qty/price(s) inputs, designated-buyer field, and
// the submit that calls createAuction. Listing duration is fixed (AUCTION_DURATION_SEC, currently
// 72h) and no longer user-selectable.
//
// Converted from CreateFormMixin(Base) to composition (2026-08-11). The former PickerMixin half of
// this flow (choosing what to list) moved to itemPickerRender.ts as plain functions instead of a
// merged sibling class — see that file's header comment for why: once "return to the create form"
// goes through Core's `reopenCreateForm` lazy hook instead of a direct method call, the two mixins'
// bidirectional dependency (picker→openCreateForm, createForm→selectedItemLabel/openItemPicker)
// evaporates entirely, so there's nothing left that needs `this`/a class on the picker side.
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, sketchButton, seedFor, tearDownChildren } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { t } from '../../i18n';
import { buildIcon } from '../../render/icons';
import { buildMaterialIcon, type MaterialKind } from '../../render/atlas/materialAtlas';
import { caretDisplay } from '../../ui/inputDisplay';
import { AUCTION_DURATION_SEC } from './types';
import type { AuctionSceneCore } from './core';
import { itemKind, saleModeKind } from './itemLabels';
import { addNumInput } from './numInput';
import { listableEquipment, openItemPicker, selectedItemLabel } from './itemPickerRender';

// Dialog is rendered 1.5x larger than the original design for legibility.
// Exported so tests can compute expected geometry (item-field height/icon size/etc.) instead of
// re-hardcoding the multiplier — see test/ui/auctionScene.ui.ts's item-field describe block.
export const SCALE = 1.5;
// Vertical metrics use an extra 1.2x so the dialog stands 20% taller (roomier row spacing) than its
// content-derived height, while element widths/fonts stay at SCALE.
const VA = SCALE * 1.2;
const ROW = 46 * VA;

export class CreateListingPanel {
  constructor(private readonly core: AuctionSceneCore) {}

  /**
   * Server price-guard category for the item currently selected in the create form
   * (`material:<mat>` / `equip:<defId>:<level>`), or null for classes with no guardrail (cards). Mirrors
   * the server's categoryOf so the band we fetch matches the band createAuction will enforce.
   */
  private currentListingCategory(): string | null {
    const core = this.core;
    if (core.createClass === 'material') return `material:${core.createMaterial}`;
    if (core.createClass === 'equipment') {
      const inst = listableEquipment(core).find((e) => e.id === core.createEquipId);
      return inst ? `equip:${inst.defId}:${inst.level}` : null;
    }
    return null; // card: no price window (server passes through)
  }

  openCreateForm(): void {
    const core = this.core;
    const { w, h } = core;
    const ml = core.modalLayer;
    tearDownChildren(ml);
    core.modalHits = [];
    core.modalOpen = true;

    const auctionMode = core.createSaleMode === 'auction';
    const isMaterial = core.createClass === 'material';
    const mw = Math.min(360 * SCALE, w - 24);
    const priceRowsH = auctionMode ? ROW * 2 : ROW; // auction: startPrice + buyout
    // Keep the price guardrail band for the current item in sync (fires one fetch per item selection).
    core.ensureRefBand(this.currentListingCategory());
    // item(field=48, doubled to 78 below — the extra 30*SCALE isn't part of the VA-scaled group)
    // + [qty only for material] + saleMode + price(s) + refBand(22) + buyer(label+field=60) + info(26) + buttons(50) + pads(26)
    const mh = (16 + 48 + 60 + 26 + 22 + 50 + 10) * VA + 30 * SCALE + ROW * (1 + (isMaterial ? 1 : 0)) + priceRowsH;
    const mx = (w - mw) / 2;
    const my = Math.max(50 + 4, (h - mh) / 2);

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.4).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    let cy = my + 16 * VA;

    // Item — unified selector across material/equipment/card: tap opens a picker listing every sellable
    // item (materials always offered; equipment/card require getSave), sorted by estimated value descending.
    // Field is 2x the normal input row height and gets an emphasized fill/border/bold-large label once
    // an item is picked, so the currently-listed item reads at a glance (2026-08-08, "重点显示当前出售物品").
    const il0 = txt(t('auction.item') + ':', snapFont(13 * SCALE), C.dark);
    il0.x = mx + 10 * SCALE; il0.y = cy;
    ml.addChild(il0);
    const selLabel = selectedItemLabel(core);
    const itemFieldH = 60 * SCALE; // doubled from the standard 30*SCALE input row
    const itemIconSize = 32 * SCALE;
    const field = sketchPanel(mw - 20 * SCALE, itemFieldH, {
      fill: selLabel ? 0xeaf1fb : 0xfaf9f5,
      border: selLabel ? C.accent : C.mid,
      width: selLabel ? 3 : 2,
      seed: seedFor(cy, 2, mw - 20 * SCALE),
    });
    field.x = mx + 10 * SCALE; field.y = cy + 18 * SCALE;
    ml.addChild(field);
    const itemIconKind = itemKind(core.createClass, core.createMaterial);
    const ic = itemIconKind === 'scrap' || itemIconKind === 'lead' || itemIconKind === 'binding'
      ? buildMaterialIcon(itemIconKind as MaterialKind, itemIconSize, selLabel ? C.dark : C.mid)
      : buildIcon(itemIconKind, itemIconSize, selLabel ? C.dark : C.mid);
    ic.x = mx + 16 * SCALE; ic.y = field.y + (itemFieldH - itemIconSize) / 2;
    ml.addChild(ic);
    const fl = txt(selLabel ?? t('auction.tapChoose'), snapFont((selLabel ? 17 : 13) * SCALE), selLabel ? C.dark : C.mid, !!selLabel);
    fl.anchor.set(0, 0.5);
    fl.x = mx + 16 * SCALE + itemIconSize + 10 * SCALE; fl.y = field.y + itemFieldH / 2;
    ml.addChild(fl);
    core.modalHits.push({ rect: { x: mx + 10 * SCALE, y: field.y, w: mw - 20 * SCALE, h: itemFieldH }, fn: () => openItemPicker(core) });
    cy += 48 * VA + 30 * SCALE;

    // Qty (material only; equipment/card are unique instances, qty forced to 1 server-side).
    if (isMaterial) {
      addNumInput(core, ml, mx, cy, t('auction.qty') + ':', core.createQty, (v) => { core.createQty = Math.max(1, v); this.openCreateForm(); }, SCALE);
      cy += ROW;
    }

    // Sale mode toggle (fixed buy-now / auction)
    const sm0 = txt(t('auction.saleMode') + ':', snapFont(13 * SCALE), C.dark);
    sm0.x = mx + 10 * SCALE; sm0.y = cy;
    ml.addChild(sm0);
    let sx = mx + 10 * SCALE + sm0.width + 8 * SCALE;
    const modes: { key: 'fixed' | 'auction'; label: string }[] = [
      { key: 'fixed', label: t('auction.saleFixed') },
      { key: 'auction', label: t('auction.saleAuction') },
    ];
    for (let i = 0; i < modes.length; i++) {
      const md = modes[i]!;
      const active = md.key === core.createSaleMode;
      const btnW = 80 * SCALE, btnH = 26 * SCALE;
      const btn = sketchPanel(btnW, btnH, { fill: active ? C.dark : 0xeeeeee, border: active ? C.accent : C.mid, seed: seedFor(i, 5, btnW) });
      btn.x = sx; btn.y = cy - 2 * SCALE;
      ml.addChild(btn);
      const mi = buildIcon(saleModeKind(md.key), 15 * SCALE, active ? C.light : C.dark);
      mi.x = sx + 6 * SCALE; mi.y = cy + 3 * SCALE;
      ml.addChild(mi);
      const bl = txt(md.label, snapFont(12 * SCALE), active ? C.light : C.dark);
      bl.anchor.set(0.5, 0.5); bl.x = sx + 46 * SCALE; bl.y = cy + 11 * SCALE;
      ml.addChild(bl);
      core.modalHits.push({ rect: { x: sx, y: cy - 2 * SCALE, w: btnW, h: btnH }, fn: () => { core.createSaleMode = md.key; this.openCreateForm(); } });
      sx += 84 * SCALE;
    }
    cy += ROW;

    // Price(s) — fixed: single buy-now price; auction: startPrice + optional buyout
    if (auctionMode) {
      addNumInput(core, ml, mx, cy, t('auction.startPrice') + ':', core.createStartPrice, (v) => { core.createStartPrice = Math.max(1, v); this.openCreateForm(); }, SCALE, { editKey: 'startPrice', clamp: (v) => this.clampToBand(v) });
      cy += ROW;
      addNumInput(core, ml, mx, cy, t('auction.buyout') + ':', core.createBuyoutPrice, (v) => { core.createBuyoutPrice = Math.max(0, v); this.openCreateForm(); }, SCALE, { editKey: 'buyout' });
      cy += ROW;
    } else {
      addNumInput(core, ml, mx, cy, t('auction.price') + ':', core.createPrice, (v) => { core.createPrice = Math.max(1, v); this.openCreateForm(); }, SCALE, { editKey: 'price', clamp: (v) => this.clampToBand(v) });
      cy += ROW;
    }

    // Price guardrail hint — surfaces the acceptable range for the selected item so the seller sees it
    // up front instead of only hitting PRICE_OUT_OF_RANGE on submit. The guarded unit price is the buy-now
    // price (fixed) / start price (auction), matching the server's checkPriceGuard. Turns red when the
    // current price falls outside the band; "no limit" for cards / cold-start categories.
    const listPrice = auctionMode ? core.createStartPrice : core.createPrice;
    let refText: string;
    let refColor: number = C.mid;
    if (core.refBandLoading) {
      refText = t('auction.refLoading');
    } else if (core.refBand) {
      refText = t('auction.refRange', {
        ref: Math.round(core.refBand.ref),
        min: Math.ceil(core.refBand.floor),
        max: Math.floor(core.refBand.ceil),
      });
      if (listPrice < core.refBand.floor || listPrice > core.refBand.ceil) refColor = C.red;
    } else {
      refText = t('auction.refUnrestricted');
    }
    const refLbl = txt(refText, snapFont(11 * SCALE), refColor);
    refLbl.x = mx + 10 * SCALE; refLbl.y = cy;
    ml.addChild(refLbl);
    cy += 22 * VA;

    // Designated buyer (optional) — private sale to a specific account.
    const bl0 = txt(t('auction.buyer') + ':', snapFont(12 * SCALE), C.dark);
    bl0.x = mx + 10 * SCALE; bl0.y = cy;
    ml.addChild(bl0);
    const buyerField = sketchPanel(mw - 20 * SCALE, 28 * SCALE, { fill: 0xfaf9f5, border: core.buyerActive ? C.accent : C.mid, seed: seedFor(cy, 0, mw - 20 * SCALE) });
    buyerField.x = mx + 10 * SCALE; buyerField.y = cy + 18 * SCALE;
    ml.addChild(buyerField);
    const bfl = txt(caretDisplay(core.createBuyer, core.buyerActive && core.caretOn, t('auction.buyerPlaceholder')), snapFont(12 * SCALE), core.createBuyer ? C.dark : C.mid);
    bfl.x = mx + 16 * SCALE; bfl.y = cy + 25 * SCALE;
    ml.addChild(bfl);
    core.modalHits.push({ rect: { x: mx + 10 * SCALE, y: cy + 18 * SCALE, w: mw - 20 * SCALE, h: 28 * SCALE }, fn: () => this.openBuyerInput() });
    cy += 60 * VA;

    // Tax info — estimate seller proceeds at the floor price (start/buy-now).
    const refPrice = auctionMode ? core.createStartPrice : core.createPrice;
    const youGet = refPrice - Math.floor(refPrice * 0.1);
    const taxLbl = txt(`${t('auction.youGet')}: ${youGet}`, snapFont(12 * SCALE), C.mid);
    taxLbl.x = mx + 10 * SCALE; taxLbl.y = cy;
    ml.addChild(taxLbl);
    cy += 26 * VA;

    // OK / Cancel
    const btnW = 90 * SCALE, btnH = 32 * SCALE;
    const okBtn = sketchButton(btnW, btnH, seedFor(0, 0, btnW));
    okBtn.x = mx + mw / 2 - 98 * SCALE; okBtn.y = cy;
    ml.addChild(okBtn);
    const ol = txt(t('auction.create'), snapFont(13 * SCALE), C.light);
    ol.anchor.set(0.5, 0.5); ol.x = mx + mw / 2 - 53 * SCALE; ol.y = cy + 16 * SCALE;
    ml.addChild(ol);
    core.modalHits.push({ rect: { x: okBtn.x, y: okBtn.y, w: btnW, h: btnH }, fn: () => void this.doCreate() });

    const caBtn = sketchPanel(btnW, btnH, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 1, btnW) });
    caBtn.x = mx + mw / 2 + 8 * SCALE; caBtn.y = cy;
    ml.addChild(caBtn);
    const cl = buildIcon('close', 15 * SCALE, C.dark);
    cl.x = mx + mw / 2 + 53 * SCALE - 7 * SCALE; cl.y = cy + 16 * SCALE - 7 * SCALE;
    ml.addChild(cl);
    core.modalHits.push({ rect: { x: caBtn.x, y: caBtn.y, w: btnW, h: btnH }, sound: 'sfx.ui.back', fn: () => core.closeModal() });
  }

  // Snap a typed price into the item's allowed guardrail band: below floor → floor, above ceil → ceil.
  // With no loaded band (cards / cold-start categories) the price passes through unchanged (min 1).
  private clampToBand(v: number): number {
    const b = this.core.refBand;
    if (!b) return Math.max(1, v);
    return Math.min(Math.floor(b.ceil), Math.max(Math.ceil(b.floor), v));
  }

  private openBuyerInput(): void {
    const core = this.core;
    core.buyerActive = true;
    core.caretOn = true;
    core.caretTimer = 0;
    const handle = core.cb.openTextInput({
      value: core.createBuyer,
      maxLength: 64,
      onInput: (value) => {
        core.createBuyer = value.trim();
        if (!core.destroyed && core.modalOpen) this.openCreateForm();
      },
      onComplete: () => {
        core.buyerActive = false;
        if (core.textInput === handle) core.textInput = null;
        if (!core.destroyed && core.modalOpen) this.openCreateForm();
      },
    });
    core.textInput = handle;
  }

  async doCreate(): Promise<void> {
    const core = this.core;
    const buyer = core.createBuyer.trim();
    const auctionMode = core.createSaleMode === 'auction';
    const cls = core.createClass;

    // Resolve the item payload + qty per class; equipment/card/skin require a picked instance/id (qty forced to 1 server-side).
    let itemType: 'material' | 'equipment' | 'card' | 'skin';
    let item: Record<string, unknown>;
    let qty: number;
    if (cls === 'equipment') {
      if (!core.createEquipId) { core.showToast(t('auction.selectItem'), C.red); return; }
      itemType = 'equipment'; item = { instanceId: core.createEquipId }; qty = 1;
    } else if (cls === 'card') {
      if (!core.createCardId) { core.showToast(t('auction.selectItem'), C.red); return; }
      itemType = 'card'; item = { instanceId: core.createCardId }; qty = 1;
    } else if (cls === 'skin') {
      if (!core.createSkinId) { core.showToast(t('auction.selectItem'), C.red); return; }
      itemType = 'skin'; item = { skinId: core.createSkinId }; qty = 1;
    } else {
      itemType = 'material'; item = { material: core.createMaterial }; qty = core.createQty;
    }

    core.closeModal();
    try {
      await core.cb.worldApi.createAuction(
        itemType, item, qty, AUCTION_DURATION_SEC,
        auctionMode
          ? {
              saleMode: 'auction',
              startPrice: core.createStartPrice,
              buyoutPrice: core.createBuyoutPrice > 0 ? core.createBuyoutPrice : undefined,
              designatedBuyerId: buyer || undefined,
            }
          : { saleMode: 'fixed', price: core.createPrice, designatedBuyerId: buyer || undefined },
      );
      core.createBuyer = '';
      // Escrow removed the instance from inventory server-side → re-pull the authoritative save so the
      // picker no longer offers it. Materials are server-authoritative too but not shown in a local picker.
      if (cls !== 'material') { core.createEquipId = null; core.createCardId = null; core.createSkinId = null; await core.cb.reloadSave?.(); }
      core.showToast(t('auction.created'));
      await core.loadData();
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    }
  }
}
