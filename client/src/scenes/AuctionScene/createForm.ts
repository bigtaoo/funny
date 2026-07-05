// Create-listing modal: unified item field (tap → picker across material/equipment/card), sale-mode
// toggle, qty/price(s) inputs, designated-buyer field, and the submit that calls createAuction.
// Listing duration is fixed (AUCTION_DURATION_SEC, currently 72h) and no longer user-selectable.
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { t } from '../../i18n';
import { buildIcon } from '../../render/icons';
import { caretDisplay } from '../../render/inputDisplay';
import { AUCTION_DURATION_SEC, type Constructor, type AuctionSceneBaseCtor } from './base';

export interface CreateFormHandlers {
  openCreateForm(): void;
  doCreate(): Promise<void>;
}

const ROW = 46;

export function CreateFormMixin<TBase extends AuctionSceneBaseCtor>(Base: TBase): TBase & Constructor<CreateFormHandlers> {
  return class extends Base {
    openCreateForm(): void {
      const { w, h } = this;
      const ml = this.modalLayer;
      ml.removeChildren();
      this.modalHits = [];
      this.modalOpen = true;

      const auctionMode = this.createSaleMode === 'auction';
      const isMaterial = this.createClass === 'material';
      const mw = Math.min(360, w - 24);
      const priceRowsH = auctionMode ? ROW * 2 : ROW; // auction: startPrice + buyout
      // item(field=48) + [qty only for material] + saleMode + price(s) + buyer(label+field=60) + info(26) + buttons(50) + pads(26)
      const mh = 16 + 48 + ROW * (1 + (isMaterial ? 1 : 0)) + priceRowsH + 60 + 26 + 50 + 10;
      const mx = (w - mw) / 2;
      const my = Math.max(50 + 4, (h - mh) / 2);

      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000, 0.4).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim);

      const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
      panel.x = mx; panel.y = my;
      ml.addChild(panel);

      let cy = my + 16;

      // Item — unified selector across material/equipment/card: tap opens a picker listing every sellable
      // item (materials always offered; equipment/card require getSave), sorted by estimated value descending.
      const il0 = txt(t('auction.item') + ':', 13, C.dark);
      il0.x = mx + 10; il0.y = cy;
      ml.addChild(il0);
      const selLabel = this.selectedItemLabel();
      const field = sketchPanel(mw - 20, 30, { fill: 0xfaf9f5, border: selLabel ? C.accent : C.mid, seed: seedFor(cy, 2, mw - 20) });
      field.x = mx + 10; field.y = cy + 18;
      ml.addChild(field);
      const ic = buildIcon(this.itemKind(this.createClass, this.createMaterial), 16, selLabel ? C.dark : C.mid);
      ic.x = mx + 16; ic.y = cy + 24;
      ml.addChild(ic);
      const fl = txt(selLabel ?? t('auction.tapChoose'), 12, selLabel ? C.dark : C.mid);
      fl.x = mx + 38; fl.y = cy + 25;
      ml.addChild(fl);
      this.modalHits.push({ rect: { x: mx + 10, y: cy + 18, w: mw - 20, h: 30 }, action: () => this.openItemPicker() });
      cy += 48;

      // Qty (material only; equipment/card are unique instances, qty forced to 1 server-side).
      if (isMaterial) {
        this.addNumInput(ml, mx, cy, t('auction.qty') + ':', this.createQty, (v) => { this.createQty = Math.max(1, v); this.openCreateForm(); });
        cy += ROW;
      }

      // Sale mode toggle (fixed buy-now / auction)
      const sm0 = txt(t('auction.saleMode') + ':', 13, C.dark);
      sm0.x = mx + 10; sm0.y = cy;
      ml.addChild(sm0);
      let sx = mx + 10 + sm0.width + 8;
      const modes: { key: 'fixed' | 'auction'; label: string }[] = [
        { key: 'fixed', label: t('auction.saleFixed') },
        { key: 'auction', label: t('auction.saleAuction') },
      ];
      for (let i = 0; i < modes.length; i++) {
        const md = modes[i]!;
        const active = md.key === this.createSaleMode;
        const btn = sketchPanel(80, 26, { fill: active ? C.dark : 0xeeeeee, border: active ? C.accent : C.mid, seed: seedFor(i, 5, 80) });
        btn.x = sx; btn.y = cy - 2;
        ml.addChild(btn);
        const mi = buildIcon(this.saleModeKind(md.key), 15, active ? C.light : C.dark);
        mi.x = sx + 6; mi.y = cy + 3;
        ml.addChild(mi);
        const bl = txt(md.label, 12, active ? C.light : C.dark);
        bl.anchor.set(0.5, 0.5); bl.x = sx + 46; bl.y = cy + 11;
        ml.addChild(bl);
        this.modalHits.push({ rect: { x: sx, y: cy - 2, w: 80, h: 26 }, action: () => { this.createSaleMode = md.key; this.openCreateForm(); } });
        sx += 84;
      }
      cy += ROW;

      // Price(s) — fixed: single buy-now price; auction: startPrice + optional buyout
      if (auctionMode) {
        this.addNumInput(ml, mx, cy, t('auction.startPrice') + ':', this.createStartPrice, (v) => { this.createStartPrice = Math.max(1, v); this.openCreateForm(); });
        cy += ROW;
        this.addNumInput(ml, mx, cy, t('auction.buyout') + ':', this.createBuyoutPrice, (v) => { this.createBuyoutPrice = Math.max(0, v); this.openCreateForm(); });
        cy += ROW;
      } else {
        this.addNumInput(ml, mx, cy, t('auction.price') + ':', this.createPrice, (v) => { this.createPrice = Math.max(1, v); this.openCreateForm(); });
        cy += ROW;
      }

      // Designated buyer (optional) — private sale to a specific account.
      const bl0 = txt(t('auction.buyer') + ':', 12, C.dark);
      bl0.x = mx + 10; bl0.y = cy;
      ml.addChild(bl0);
      const buyerField = sketchPanel(mw - 20, 28, { fill: 0xfaf9f5, border: this.buyerActive ? C.accent : C.mid, seed: seedFor(cy, 0, mw - 20) });
      buyerField.x = mx + 10; buyerField.y = cy + 18;
      ml.addChild(buyerField);
      const bfl = txt(caretDisplay(this.createBuyer, this.buyerActive && this.caretOn, t('auction.buyerPlaceholder')), 12, this.createBuyer ? C.dark : C.mid);
      bfl.x = mx + 16; bfl.y = cy + 25;
      ml.addChild(bfl);
      this.modalHits.push({ rect: { x: mx + 10, y: cy + 18, w: mw - 20, h: 28 }, action: () => this.openBuyerInput() });
      cy += 60;

      // Tax info — estimate seller proceeds at the floor price (start/buy-now).
      const refPrice = auctionMode ? this.createStartPrice : this.createPrice;
      const youGet = refPrice - Math.floor(refPrice * 0.1);
      const taxLbl = txt(`${t('auction.youGet')}: ${youGet}`, 12, C.mid);
      taxLbl.x = mx + 10; taxLbl.y = cy;
      ml.addChild(taxLbl);
      cy += 26;

      // OK / Cancel
      const okBtn = sketchPanel(90, 32, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, 90) });
      okBtn.x = mx + mw / 2 - 98; okBtn.y = cy;
      ml.addChild(okBtn);
      const ol = txt(t('auction.create'), 13, C.light);
      ol.anchor.set(0.5, 0.5); ol.x = mx + mw / 2 - 53; ol.y = cy + 16;
      ml.addChild(ol);
      this.modalHits.push({ rect: { x: okBtn.x, y: okBtn.y, w: 90, h: 32 }, action: () => void this.doCreate() });

      const caBtn = sketchPanel(90, 32, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 1, 90) });
      caBtn.x = mx + mw / 2 + 8; caBtn.y = cy;
      ml.addChild(caBtn);
      const cl = buildIcon('close', 15, C.dark);
      cl.x = mx + mw / 2 + 53 - 7; cl.y = cy + 16 - 7;
      ml.addChild(cl);
      this.modalHits.push({ rect: { x: caBtn.x, y: caBtn.y, w: 90, h: 32 }, action: () => this.closeModal() });
    }

    private openBuyerInput(): void {
      this.buyerActive = true;
      this.caretOn = true;
      this.caretTimer = 0;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = this.createBuyer;
      inp.maxLength = 64;
      inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(inp);
      inp.focus();
      inp.addEventListener('input', () => {
        this.createBuyer = inp.value.trim();
        if (!this.destroyed && this.modalOpen) this.openCreateForm();
      });
      inp.addEventListener('blur', () => {
        this.buyerActive = false;
        document.body.removeChild(inp);
        if (this.hiddenInput === inp) this.hiddenInput = null;
        if (!this.destroyed && this.modalOpen) this.openCreateForm();
      });
      this.hiddenInput = inp;
    }

    async doCreate(): Promise<void> {
      const buyer = this.createBuyer.trim();
      const auctionMode = this.createSaleMode === 'auction';
      const cls = this.createClass;

      // Resolve the item payload + qty per class; equipment/card require a picked instance (qty forced to 1 server-side).
      let itemType: 'material' | 'equipment' | 'card';
      let item: Record<string, unknown>;
      let qty: number;
      if (cls === 'equipment') {
        if (!this.createEquipId) { this.showToast(t('auction.selectItem'), C.red); return; }
        itemType = 'equipment'; item = { instanceId: this.createEquipId }; qty = 1;
      } else if (cls === 'card') {
        if (!this.createCardId) { this.showToast(t('auction.selectItem'), C.red); return; }
        itemType = 'card'; item = { instanceId: this.createCardId }; qty = 1;
      } else {
        itemType = 'material'; item = { material: this.createMaterial }; qty = this.createQty;
      }

      this.closeModal();
      try {
        await this.cb.worldApi.createAuction(
          this.cb.worldId, itemType, item, qty, AUCTION_DURATION_SEC,
          auctionMode
            ? {
                saleMode: 'auction',
                startPrice: this.createStartPrice,
                buyoutPrice: this.createBuyoutPrice > 0 ? this.createBuyoutPrice : undefined,
                designatedBuyerId: buyer || undefined,
              }
            : { saleMode: 'fixed', price: this.createPrice, designatedBuyerId: buyer || undefined },
        );
        this.createBuyer = '';
        // Escrow removed the instance from inventory server-side → re-pull the authoritative save so the
        // picker no longer offers it. Materials are server-authoritative too but not shown in a local picker.
        if (cls !== 'material') { this.createEquipId = null; this.createCardId = null; await this.cb.reloadSave?.(); }
        this.showToast(t('auction.created'));
        await this.loadData();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }
  };
}
