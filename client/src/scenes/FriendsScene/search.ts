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
      this.render();
    }

    // ── Search subview ────────────────────────────────────────────────────────────

    drawSearch(): void {
      const { w, h } = this;
      const tbH = Math.round(h * 0.12);

      const prompt = txt(t('friends.searchTitle'), FS.title, C.dark, true);
      prompt.anchor.set(0.5, 0.5); prompt.x = w / 2; prompt.y = tbH + Math.round(h * 0.05);
      this.container.addChild(prompt);

      const fW = Math.round(w * 0.7);
      const fH = Math.round(h * 0.08);
      const fX = (w - fW) / 2;
      const fY = tbH + Math.round(h * 0.10);
      const field = sketchPanel(fW, fH, {
        fill: C.paper, border: this.searchDigits.length ? C.accent : C.line, width: 2, seed: seedFor(fX, fY, fW),
      });
      field.x = fX; field.y = fY;
      this.container.addChild(field);
      const shown = this.searchDigits.length ? this.searchDigits.join('') : t('friends.searchPlaceholder');
      const fTxt = txt(shown, snapFont(Math.round(fH * 0.45)), this.searchDigits.length ? C.dark : C.mid, true);
      fTxt.anchor.set(0.5, 0.5); fTxt.x = w / 2; fTxt.y = fY + fH / 2;
      this.container.addChild(fTxt);

      const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', t('friends.clear'), '0', '⌫'];
      const perRow = 3;
      const kY = fY + fH + Math.round(h * 0.03);
      const kGap = Math.round(w * 0.03);
      const kW = Math.round((w * 0.7 - (perRow - 1) * kGap) / perRow);
      const kH = Math.round(h * 0.075);
      const kX0 = (w - (perRow * kW + (perRow - 1) * kGap)) / 2;
      keys.forEach((label, i) => {
        const r = Math.floor(i / perRow);
        const c = i % perRow;
        const kx = kX0 + c * (kW + kGap);
        const ky = kY + r * (kH + kGap);
        this.addButton(label, kx, ky, kW, kH, C.paper, C.line, () => {
          if (label === '⌫') this.searchDigits.pop();
          else if (label === t('friends.clear')) this.searchDigits = [];
          else if (this.searchDigits.length < 9) this.searchDigits.push(label);
          this.searchResult = null;
          this.searchMsgKey = null;
          this.render();
        }, C.dark, snapFont(Math.round(kH * 0.4)));
      });

      const kRows = Math.ceil(keys.length / perRow);
      const sY = kY + kRows * (kH + kGap) + Math.round(h * 0.01);
      const enabled = this.searchDigits.length > 0;
      this.addButton(t('friends.searchBtn'), (w - fW) / 2, sY, fW, Math.round(h * 0.08),
        enabled ? C.dark : C.btnOff, enabled ? C.accent : C.light,
        () => { if (enabled) void this.doSearch(); }, 0xffffff);

      const ry = sY + Math.round(h * 0.11);
      if (this.searchResult) {
        const res = this.searchResult;
        const rh = Math.round(h * 0.10);
        const rx = (w - fW) / 2;
        const bg = sketchPanel(fW, rh, { fill: C.paper, border: C.accent, width: 2, seed: seedFor(rx, ry, fW) });
        bg.x = rx; bg.y = ry;
        sketchAccentBar(bg, rh, C.accent, seedFor(rx, ry, 3));
        this.container.addChild(bg);
        const nm = txt(res.displayName, snapFont(Math.round(rh * 0.3)), C.dark, true);
        nm.anchor.set(0, 0.5); nm.x = rx + Math.round(fW * 0.06); nm.y = ry + rh * 0.36;
        this.container.addChild(nm);
        const sub = txt(`#${res.publicId}${res.rank ? '  ·  ' + rankLabel(res.rank) : ''}`, snapFont(Math.round(rh * 0.2)), C.mid);
        sub.anchor.set(0, 0.5); sub.x = rx + Math.round(fW * 0.06); sub.y = ry + rh * 0.68;
        this.container.addChild(sub);
        const bW = Math.round(fW * 0.26);
        const bH = Math.round(rh * 0.52);
        this.addButton(t('friends.add'), rx + fW - bW - Math.round(fW * 0.04), ry + (rh - bH) / 2, bW, bH,
          C.green, C.green, () => void this.doAdd(res.publicId), 0xffffff, snapFont(Math.round(bH * 0.4)));
      } else if (this.searchMsgKey) {
        const msg = txt(t(this.searchMsgKey), FS.heading, C.mid);
        msg.anchor.set(0.5, 0); msg.x = w / 2; msg.y = ry;
        this.container.addChild(msg);
      }
    }
  };
}
