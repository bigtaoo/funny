// Search subview: the numeric-keypad publicId search screen (openSearch entry + drawSearch render).
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import { rankLabel, type Constructor, type FriendsSceneBaseCtor } from './base';

export interface SearchHandlers {
  openSearch(): void;
  drawSearch(): void;
}

export function SearchMixin<TBase extends FriendsSceneBaseCtor>(Base: TBase): TBase & Constructor<SearchHandlers> {
  return class extends Base {
    // ── Actions ──────────────────────────────────────────────────────────────────

    openSearch(): void {
      this.view = 'search';
      this.searchDigits = [];
      this.searchResult = null;
      this.searchMsgKey = null;
      this.scrollY = 0;
      this.render();
    }

    // ── Search subview ────────────────────────────────────────────────────────────
    // Keypad is compact and everything below the title (field/keys/button/result) lives
    // in a scrollable layer, so the result panel is always reachable even if a short
    // viewport can't fit it above the fold.

    drawSearch(): void {
      const { w, h } = this;
      const tbH = Math.round(h * 0.12);

      const prompt = txt(t('friends.searchTitle'), FS.title, C.dark, true);
      prompt.anchor.set(0.5, 0.5); prompt.x = w / 2; prompt.y = tbH + Math.round(h * 0.05);
      this.container.addChild(prompt);

      this.regionTop = tbH + Math.round(h * 0.09);
      this.regionBottom = h - Math.round(h * 0.02);
      const regionH = this.regionBottom - this.regionTop;
      const { layer } = this.scrollRegion(regionH);
      const screenY = (contentY: number) => this.regionTop + contentY - this.scrollY;

      let cy = 0;

      const fW = Math.round(w * 0.7);
      const fH = Math.round(h * 0.065);
      const fX = (w - fW) / 2;
      const fSy = screenY(cy);
      const field = sketchPanel(fW, fH, {
        fill: C.paper, border: this.searchDigits.length ? C.accent : C.line, width: 2, seed: seedFor(fX, cy, fW),
      });
      field.x = fX; field.y = fSy;
      layer.addChild(field);
      const shown = this.searchDigits.length ? this.searchDigits.join('') : t('friends.searchPlaceholder');
      const fTxt = txt(shown, snapFont(Math.round(fH * 0.4)), this.searchDigits.length ? C.dark : C.mid, true);
      fTxt.anchor.set(0.5, 0.5); fTxt.x = w / 2; fTxt.y = fSy + fH / 2;
      layer.addChild(fTxt);
      cy += fH + Math.round(h * 0.02);

      const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', t('friends.clear'), '0', '⌫'];
      const perRow = 3;
      const kGapX = Math.round(w * 0.02);
      const kGapY = Math.round(h * 0.012);
      const kW = Math.round((fW - (perRow - 1) * kGapX) / perRow);
      const kH = Math.round(h * 0.05);
      const kX0 = (w - (perRow * kW + (perRow - 1) * kGapX)) / 2;
      const kRows = Math.ceil(keys.length / perRow);
      keys.forEach((label, i) => {
        const r = Math.floor(i / perRow);
        const c = i % perRow;
        const kx = kX0 + c * (kW + kGapX);
        const ky = cy + r * (kH + kGapY);
        this.addButton(label, kx, screenY(ky), kW, kH, C.paper, C.line, () => {
          if (label === '⌫') this.searchDigits.pop();
          else if (label === t('friends.clear')) this.searchDigits = [];
          else if (this.searchDigits.length < 9) this.searchDigits.push(label);
          this.searchResult = null;
          this.searchMsgKey = null;
          this.render();
        }, C.dark, snapFont(Math.round(kH * 0.4)), layer);
      });
      cy += kRows * (kH + kGapY) + Math.round(h * 0.02);

      const enabled = this.searchDigits.length > 0;
      const btnH = Math.round(h * 0.065);
      this.addButton(t('friends.searchBtn'), (w - fW) / 2, screenY(cy), fW, btnH,
        enabled ? C.dark : C.btnOff, enabled ? C.accent : C.light,
        () => { if (enabled) void this.doSearch(); }, 0xffffff, undefined, layer);
      cy += btnH + Math.round(h * 0.03);

      if (this.searchResult) {
        const res = this.searchResult;
        const rh = Math.round(h * 0.10);
        const rx = (w - fW) / 2;
        const ry = screenY(cy);
        const bg = sketchPanel(fW, rh, { fill: C.paper, border: C.accent, width: 2, seed: seedFor(rx, cy, fW) });
        bg.x = rx; bg.y = ry;
        sketchAccentBar(bg, rh, C.accent, seedFor(rx, cy, 3));
        layer.addChild(bg);
        const nm = txt(res.displayName, snapFont(Math.round(rh * 0.3)), C.dark, true);
        nm.anchor.set(0, 0.5); nm.x = rx + Math.round(fW * 0.06); nm.y = ry + rh * 0.36;
        layer.addChild(nm);
        const sub = txt(`#${res.publicId}${res.rank ? '  ·  ' + rankLabel(res.rank) : ''}`, snapFont(Math.round(rh * 0.2)), C.mid);
        sub.anchor.set(0, 0.5); sub.x = rx + Math.round(fW * 0.06); sub.y = ry + rh * 0.68;
        layer.addChild(sub);
        const bW = Math.round(fW * 0.26);
        const bH = Math.round(rh * 0.52);
        this.addButton(t('friends.add'), rx + fW - bW - Math.round(fW * 0.04), ry + (rh - bH) / 2, bW, bH,
          C.green, C.green, () => void this.doAdd(res.publicId), 0xffffff, snapFont(Math.round(bH * 0.4)), layer);
        cy += rh;
      } else if (this.searchMsgKey) {
        const msg = txt(t(this.searchMsgKey), FS.heading, C.mid);
        msg.anchor.set(0.5, 0); msg.x = w / 2; msg.y = screenY(cy);
        layer.addChild(msg);
        cy += Math.round(h * 0.08);
      }

      this.maxScroll = Math.max(0, cy - regionH);
      if (this.scrollY > this.maxScroll) this.scrollY = this.maxScroll;
    }
  };
}
