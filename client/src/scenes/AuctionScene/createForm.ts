// Create-listing modal: item-class selector (material/equipment/card), item/instance field, sale-mode
// toggle, qty/price(s)/duration inputs, designated-buyer field, and the submit that calls createAuction.
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { t } from '../../i18n';
import { buildIcon } from '../../render/icons';
import { caretDisplay } from '../../render/inputDisplay';
import { ITEM_CLASSES, MATERIALS, DURATIONS, type ItemClass, type Constructor, type AuctionSceneBaseCtor } from './base';

export interface CreateFormHandlers {
  openCreateForm(): void;
  doCreate(): Promise<void>;
}

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
      const ROW = 40;
      const mw = Math.min(320, w - 24);
      const priceRowsH = auctionMode ? ROW * 2 : ROW; // auction: startPrice + buyout
      // class + item + [qty only for material] + saleMode + price(s) + duration + buyer(label+field=52) + info(24) + buttons(44) + pads(22)
      const mh = 14 + ROW * (4 + (isMaterial ? 1 : 0)) + priceRowsH + 52 + 24 + 44 + 8;
      const mx = (w - mw) / 2;
      const my = Math.max(50 + 4, (h - mh) / 2);

      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000, 0.4).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim);

      const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
      panel.x = mx; panel.y = my;
      ml.addChild(panel);

      let cy = my + 14;

      // Item class selector: material / equipment / card. Equipment & card need the inventory (getSave);
      // without it (e.g. tests) only material is offered.
      const canInstance = !!this.cb.getSave;
      const cl0 = txt(t('auction.itemClass') + ':', 12, C.dark);
      cl0.x = mx + 10; cl0.y = cy;
      ml.addChild(cl0);
      let cbx = mx + 10 + cl0.width + 8;
      const classKeys: Record<ItemClass, 'auction.classMaterial' | 'auction.classEquipment' | 'auction.classCard'> = {
        material: 'auction.classMaterial', equipment: 'auction.classEquipment', card: 'auction.classCard',
      };
      for (let i = 0; i < ITEM_CLASSES.length; i++) {
        const cls = ITEM_CLASSES[i]!;
        const enabled = cls === 'material' || canInstance;
        const active = cls === this.createClass;
        const fill = active ? C.dark : (enabled ? 0xeeeeee : 0xe4e4e0);
        const btn = sketchPanel(66, 24, { fill, border: active ? C.accent : C.mid, seed: seedFor(i, 7, 66) });
        btn.x = cbx; btn.y = cy - 2;
        ml.addChild(btn);
        const ci = buildIcon(this.itemKind(cls), 14, active ? C.light : (enabled ? C.dark : C.mid));
        ci.x = cbx + 4; ci.y = cy + 3;
        ml.addChild(ci);
        const bl = txt(t(classKeys[cls]), 11, active ? C.light : (enabled ? C.dark : C.mid));
        bl.anchor.set(0.5, 0.5); bl.x = cbx + 39; bl.y = cy + 10;
        ml.addChild(bl);
        if (enabled) {
          this.modalHits.push({ rect: { x: cbx, y: cy - 2, w: 66, h: 24 }, action: () => { this.createClass = cls; this.openCreateForm(); } });
        }
        cbx += 70;
      }
      cy += ROW;

      // Item row — material: material-type buttons; equipment/card: selected-instance field (tap → picker).
      if (isMaterial) {
        const tl0 = txt(t('auction.item') + ':', 12, C.dark);
        tl0.x = mx + 10; tl0.y = cy;
        ml.addChild(tl0);
        let bx = mx + 10 + tl0.width + 8;
        for (const mat of MATERIALS) {
          const active = mat === this.createMaterial;
          const matIdx = MATERIALS.indexOf(mat);
          const btn = sketchPanel(60, 24, { fill: active ? C.dark : 0xeeeeee, border: active ? C.accent : C.mid, seed: seedFor(matIdx, 0, 60) });
          btn.x = bx; btn.y = cy - 2;
          ml.addChild(btn);
          const bl = txt(t(`auction.${mat}` as 'auction.scrap' | 'auction.lead' | 'auction.binding'), 11, active ? C.light : C.dark);
          bl.anchor.set(0.5, 0.5); bl.x = bx + 30; bl.y = cy + 10;
          ml.addChild(bl);
          const m = mat;
          this.modalHits.push({ rect: { x: bx, y: cy - 2, w: 60, h: 24 }, action: () => { this.createMaterial = m; this.openCreateForm(); } });
          bx += 64;
        }
        cy += ROW;

        // Qty (material only; equipment/card are unique instances, qty forced to 1 server-side).
        this.addNumInput(ml, mx, cy, t('auction.qty') + ':', this.createQty, (v) => { this.createQty = Math.max(1, v); this.openCreateForm(); });
        cy += ROW;
      } else {
        const il0 = txt(t('auction.item') + ':', 12, C.dark);
        il0.x = mx + 10; il0.y = cy;
        ml.addChild(il0);
        const selLabel = this.selectedInstanceLabel();
        const field = sketchPanel(mw - 20, 26, { fill: 0xfaf9f5, border: selLabel ? C.accent : C.mid, seed: seedFor(cy, 2, mw - 20) });
        field.x = mx + 10; field.y = cy + 16;
        ml.addChild(field);
        const fl = txt(selLabel ?? t('auction.tapChoose'), 11, selLabel ? C.dark : C.mid);
        fl.x = mx + 16; fl.y = cy + 23;
        ml.addChild(fl);
        const kind = this.createClass as 'equipment' | 'card';
        this.modalHits.push({ rect: { x: mx + 10, y: cy + 16, w: mw - 20, h: 26 }, action: () => this.openPicker(kind) });
        cy += ROW;
      }

      // Sale mode toggle (fixed buy-now / auction)
      const sm0 = txt(t('auction.saleMode') + ':', 12, C.dark);
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
        const btn = sketchPanel(72, 24, { fill: active ? C.dark : 0xeeeeee, border: active ? C.accent : C.mid, seed: seedFor(i, 5, 72) });
        btn.x = sx; btn.y = cy - 2;
        ml.addChild(btn);
        const mi = buildIcon(this.saleModeKind(md.key), 14, active ? C.light : C.dark);
        mi.x = sx + 5; mi.y = cy + 3;
        ml.addChild(mi);
        const bl = txt(md.label, 11, active ? C.light : C.dark);
        bl.anchor.set(0.5, 0.5); bl.x = sx + 42; bl.y = cy + 10;
        ml.addChild(bl);
        this.modalHits.push({ rect: { x: sx, y: cy - 2, w: 72, h: 24 }, action: () => { this.createSaleMode = md.key; this.openCreateForm(); } });
        sx += 76;
      }
      cy += ROW;

      // Qty
      this.addNumInput(ml, mx, cy, t('auction.qty') + ':', this.createQty, (v) => { this.createQty = Math.max(1, v); this.openCreateForm(); });
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

      // Duration
      const dl0 = txt(t('auction.duration') + ':', 12, C.dark);
      dl0.x = mx + 10; dl0.y = cy;
      ml.addChild(dl0);
      const durKeys: Record<typeof DURATIONS[number], 'auction.dur6h' | 'auction.dur12h' | 'auction.dur24h'> = { 21600: 'auction.dur6h', 43200: 'auction.dur12h', 86400: 'auction.dur24h' };
      let dx = mx + 10 + dl0.width + 8;
      for (const dur of DURATIONS) {
        const active = dur === this.createDuration;
        const btn = sketchPanel(52, 24, { fill: active ? C.dark : 0xeeeeee, border: active ? C.accent : C.mid, seed: seedFor(dur, 0, 52) });
        btn.x = dx; btn.y = cy - 2;
        ml.addChild(btn);
        const bl = txt(t(durKeys[dur]), 10, active ? C.light : C.dark);
        bl.anchor.set(0.5, 0.5); bl.x = dx + 26; bl.y = cy + 10;
        ml.addChild(bl);
        const d = dur as typeof DURATIONS[number];
        this.modalHits.push({ rect: { x: dx, y: cy - 2, w: 52, h: 24 }, action: () => { this.createDuration = d; this.openCreateForm(); } });
        dx += 56;
      }
      cy += ROW;

      // Designated buyer (optional) — private sale to a specific account.
      const bl0 = txt(t('auction.buyer') + ':', 11, C.dark);
      bl0.x = mx + 10; bl0.y = cy;
      ml.addChild(bl0);
      const buyerField = sketchPanel(mw - 20, 26, { fill: 0xfaf9f5, border: this.buyerActive ? C.accent : C.mid, seed: seedFor(cy, 0, mw - 20) });
      buyerField.x = mx + 10; buyerField.y = cy + 16;
      ml.addChild(buyerField);
      const bfl = txt(caretDisplay(this.createBuyer, this.buyerActive && this.caretOn, t('auction.buyerPlaceholder')), 11, this.createBuyer ? C.dark : C.mid);
      bfl.x = mx + 16; bfl.y = cy + 23;
      ml.addChild(bfl);
      this.modalHits.push({ rect: { x: mx + 10, y: cy + 16, w: mw - 20, h: 26 }, action: () => this.openBuyerInput() });
      cy += 52;

      // Tax info — estimate seller proceeds at the floor price (start/buy-now).
      const refPrice = auctionMode ? this.createStartPrice : this.createPrice;
      const youGet = refPrice - Math.floor(refPrice * 0.1);
      const taxLbl = txt(`${t('auction.youGet')}: ${youGet}`, 11, C.mid);
      taxLbl.x = mx + 10; taxLbl.y = cy;
      ml.addChild(taxLbl);
      cy += 24;

      // OK / Cancel
      const okBtn = sketchPanel(80, 28, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, 80) });
      okBtn.x = mx + mw / 2 - 88; okBtn.y = cy;
      ml.addChild(okBtn);
      const ol = txt(t('auction.create'), 12, C.light);
      ol.anchor.set(0.5, 0.5); ol.x = mx + mw / 2 - 48; ol.y = cy + 14;
      ml.addChild(ol);
      this.modalHits.push({ rect: { x: okBtn.x, y: okBtn.y, w: 80, h: 28 }, action: () => void this.doCreate() });

      const caBtn = sketchPanel(80, 28, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 1, 80) });
      caBtn.x = mx + mw / 2 + 8; caBtn.y = cy;
      ml.addChild(caBtn);
      const cl = buildIcon('close', 14, C.dark);
      cl.x = mx + mw / 2 + 48 - 7; cl.y = cy + 14 - 7;
      ml.addChild(cl);
      this.modalHits.push({ rect: { x: caBtn.x, y: caBtn.y, w: 80, h: 28 }, action: () => this.closeModal() });
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
          this.cb.worldId, itemType, item, qty, this.createDuration,
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
