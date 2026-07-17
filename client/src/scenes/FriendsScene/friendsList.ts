// Friends tab: the friend/request list (drawList) + its rows + the friend profile popup entry.
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import type { FriendView, FriendRequestView } from '../../net/ApiClient';
import { rankLabel, type Constructor, type FriendsSceneBaseCtor } from './base';

export interface FriendsListHandlers {
  drawList(): void;
}

export function FriendsListMixin<TBase extends FriendsSceneBaseCtor>(Base: TBase): TBase & Constructor<FriendsListHandlers> {
  return class extends Base {
    // ── Friends tab ───────────────────────────────────────────────────────────────

    drawList(): void {
      const { w, h } = this;
      const aY = this.bodyTop + Math.round(h * 0.01);
      const aH = Math.round(h * 0.075);
      const aGap = Math.round(w * 0.02);
      const aW = Math.round((this.cW - aGap) / 2);
      const aX0 = this.cX;
      this.addButton(t('friends.search'), aX0, aY, aW, aH, C.dark, C.accent, () => this.openSearch());
      this.addButton(t('friends.room'), aX0 + aW + aGap, aY, aW, aH, C.dark, C.gold, () => this.cb.onOpenRoom());

      this.regionTop = aY + aH + Math.round(h * 0.02);
      this.regionBottom = h - Math.round(h * 0.02);
      const regionH = this.regionBottom - this.regionTop;

      const clip = new PIXI.Graphics();
      clip.beginFill(0xffffff);
      clip.drawRect(0, this.regionTop, w, regionH);
      clip.endFill();
      this.container.addChild(clip);
      const layer = new PIXI.Container();
      layer.mask = clip;
      this.container.addChild(layer);

      if (this.loading) {
        const l = txt(t('friends.loading'), FS.title, C.mid);
        l.anchor.set(0.5, 0.5); l.x = this.cCX; l.y = this.regionTop + regionH / 2;
        layer.addChild(l);
        this.maxScroll = 0;
        return;
      }

      let cy = 0;
      const rowGap = Math.round(h * 0.014);
      const screenY = (contentY: number) => this.regionTop + contentY - this.scrollY;

      const sectionLabel = (key: TranslationKey, count?: number): void => {
        const label = txt(count !== undefined ? `${t(key)} (${count})` : t(key), FS.heading, C.mid, true);
        label.anchor.set(0, 0.5); label.x = this.cX; label.y = screenY(cy + Math.round(h * 0.018));
        layer.addChild(label);
        cy += Math.round(h * 0.045);
      };

      if (this.incoming.length > 0) {
        sectionLabel('friends.requests', this.incoming.length);
        const reqH = Math.round(h * 0.09);
        for (const r of this.incoming) {
          const sy = screenY(cy);
          if (this.rowVisible(sy, reqH)) this.drawRequestRow(layer, r, cy, sy);
          cy += reqH + rowGap;
        }
        cy += Math.round(h * 0.01);
      }

      sectionLabel('friends.sectionFriends', this.friends.length);
      if (this.friends.length === 0) {
        const empty = txt(t('friends.empty'), FS.heading, C.mid);
        empty.anchor.set(0.5, 0); empty.x = this.cCX; empty.y = screenY(cy + Math.round(h * 0.02));
        layer.addChild(empty);
        cy += Math.round(h * 0.08);
      } else {
        const sorted = [...this.friends].sort(
          (a, b) => (a.online === b.online ? a.displayName.localeCompare(b.displayName) : a.online ? -1 : 1),
        );
        const fH = Math.round(h * 0.10);
        for (const f of sorted) {
          const sy = screenY(cy);
          if (this.rowVisible(sy, fH)) this.drawFriendRow(layer, f, cy, sy);
          cy += fH + rowGap;
        }
      }

      this.maxScroll = Math.max(0, cy - regionH);
      if (this.scrollY > this.maxScroll) this.scrollY = this.maxScroll;
    }

    private drawRequestRow(layer: PIXI.Container, r: FriendRequestView, _contentY: number, y: number): void {
      const { h } = this;
      const rh = Math.round(h * 0.09);
      const rx = this.cX;
      const rw = this.cW;

      const bg = sketchPanel(rw, rh, { fill: C.paper, border: C.gold, width: 2, seed: seedFor(rx, 0, rw) });
      bg.x = rx; bg.y = y;
      sketchAccentBar(bg, rh, C.gold, seedFor(rx, rh, 5));
      layer.addChild(bg);

      const name = txt(r.fromName || t('friends.you'), snapFont(Math.round(rh * 0.32)), C.dark, true);
      name.anchor.set(0, 0.5); name.x = rx + Math.round(rw * 0.06); name.y = y + rh * 0.36;
      layer.addChild(name);
      const id = txt(`#${r.fromPublicId}`, snapFont(Math.round(rh * 0.22)), C.mid);
      id.anchor.set(0, 0.5); id.x = rx + Math.round(rw * 0.06); id.y = y + rh * 0.70;
      layer.addChild(id);

      const bW = Math.round(rw * 0.18);
      const bH = Math.round(rh * 0.5);
      const bY = y + (rh - bH) / 2;
      const rejX = rx + rw - bW - Math.round(rw * 0.03);
      const accX = rejX - bW - Math.round(rw * 0.02);
      this.addButton(t('friends.accept'), accX, bY, bW, bH, C.green, C.green,
        () => void this.doRespond(r.requestId, true), 0xffffff, snapFont(Math.round(bH * 0.4)), layer);
      this.addButton(t('friends.reject'), rejX, bY, bW, bH, C.paper, C.red,
        () => void this.doRespond(r.requestId, false), C.red, snapFont(Math.round(bH * 0.4)), layer);
    }

    private drawFriendRow(layer: PIXI.Container, f: FriendView, _contentY: number, y: number): void {
      const { h } = this;
      const rh = Math.round(h * 0.10);
      const rx = this.cX;
      const rw = this.cW;
      const accent = f.online ? C.green : C.mid;

      const bg = sketchPanel(rw, rh, { fill: C.paper, border: accent, width: 2, seed: seedFor(rx, 1, rw) });
      bg.x = rx; bg.y = y;
      sketchAccentBar(bg, rh, accent, seedFor(rx, rh, 7));
      layer.addChild(bg);

      const dot = new PIXI.Graphics();
      dot.beginFill(f.online ? C.green : C.btnOff);
      dot.drawCircle(0, 0, Math.round(rh * 0.1));
      dot.endFill();
      dot.x = rx + Math.round(rw * 0.06); dot.y = y + rh / 2;
      layer.addChild(dot);

      const tx = rx + Math.round(rw * 0.12);
      const name = txt(f.alias || f.displayName, snapFont(Math.round(rh * 0.30)), C.dark, true);
      name.anchor.set(0, 0.5); name.x = tx; name.y = y + rh * 0.34;
      layer.addChild(name);

      const statusTxt = t(f.online ? 'friends.online' : 'friends.offline');
      const idRank = `#${f.publicId}${f.rank ? '  ·  ' + rankLabel(f.rank) : ''}  ·  ${statusTxt}`;
      const sub = txt(idRank, snapFont(Math.round(rh * 0.2)), C.mid);
      sub.anchor.set(0, 0.5); sub.x = tx; sub.y = y + rh * 0.68;
      layer.addChild(sub);

      const xW = Math.round(rh * 0.62);
      const xX = rx + rw - xW - Math.round(rw * 0.03);
      const xY = y + (rh - xW) / 2;
      this.addButton('✕', xX, xY, xW, xW, C.paper, C.red,
        () => void this.doRemove(f.publicId), C.red, snapFont(Math.round(xW * 0.5)), layer);

      this.hits.push({ rect: { x: rx, y, w: rw, h: rh }, scroll: true, fn: () => this.openFriendProfile(f) });
    }

    private openFriendProfile(f: FriendView): void {
      this.popup.show({
        name: f.alias || f.displayName,
        publicId: f.publicId,
        ...(f.rank ? { rankKey: 'rank.' + f.rank } : {}),
        actions: [
          { labelKey: 'friends.message', fn: () => this.cb.openChat(f.publicId, f.alias || f.displayName) },
          { labelKey: 'friends.block', fn: () => void this.doBlock(f.publicId), danger: true },
        ],
      });
    }
  };
}
