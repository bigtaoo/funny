// WorldMap HUD: header-bar content (production readout + shop/auction entry points) and the
// persistent bottom HUD (chat bar, march badge, action buttons). Rebuilt wholesale on every
// ~5s march poll, so each renderer tears its layer down first.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../../i18n';
import { ui as C, txt, sketchPanel, sketchButton, seedFor, tearDownChildren } from '../../../render/sketchUi';
import { buildIcon } from '../../../render/icons';
import { FS, snapFont } from '../../../render/fontScale';
import { serverNow } from '../../../net/serverClock';
import { MARCH_RETURN_SPEEDUP_SECS_PER_COIN } from '@nw/shared';
import { getResTexture } from '../../../render/atlas/resAtlasLoader';
import { HUD_H } from '../constants';
import type { IconKind } from '../../../render/icons';
import type { Constructor, WorldMapPanelsBaseCtor } from './base';

export interface HudHandlers {
  renderHud(): void;
}

export function HudMixin<TBase extends WorldMapPanelsBaseCtor>(Base: TBase): TBase & Constructor<HudHandlers> {
  return class extends Base {
    /**
     * Header-bar content (drawn into ctx.headerHudLayer, above the static topLayer chrome):
     * per-resource production rate centered in the bar, and the auction button pinned to its
     * far right. Rebuilt alongside hudLayer on every ~5s march poll so production stays live.
     */
    private renderHeaderHud(): void {
      const layer = this.ctx.headerHudLayer;
      tearDownChildren(layer);
      const { w } = this.ctx;
      const headerH = this.ctx.topInset;

      // Auction button — far right of the header bar. Width auto-fits the icon+label so the
      // text never clips, and the larger right margin (56) pulls it clear of the screen edge.
      const aucH = Math.round(headerH * 0.7);
      const aIconSize = Math.round(aucH * 0.4);
      const aIcon = buildIcon('tag', aIconSize, C.light);
      const aTxt = txt(t('world.auction'), snapFont(Math.round(aucH * 0.34)), C.light);
      aTxt.anchor.set(0, 0.5);
      const aGrpW = aIconSize + 4 + aTxt.width;
      const aucW = Math.ceil(aGrpW) + 24; // horizontal padding around the content group
      const aucBtn = sketchButton(aucW, aucH, seedFor(1, 0, aucW));
      aucBtn.x = w - aucW - 56; aucBtn.y = (headerH - aucH) / 2;
      layer.addChild(aucBtn);
      const aGx = aucBtn.x + (aucW - aGrpW) / 2;
      aIcon.x = aGx; aIcon.y = aucBtn.y + (aucH - aIconSize) / 2;
      aTxt.x = aGx + aIconSize + 4; aTxt.y = aucBtn.y + aucH / 2;
      layer.addChild(aIcon); layer.addChild(aTxt);
      this.ctx.aucBtnRect = { x: aucBtn.x, y: aucBtn.y, w: aucW, h: aucH };

      // Shop button — immediately left of the auction button, same sizing/style so the pair
      // reads as one entry-point group (2026-08-02: shop pulled out of the Territory Overview
      // panel into its own item-card catalog — see openShopPanel/renderShopPanel).
      const sIconSize = aIconSize;
      const sIcon = buildIcon('coinSack', sIconSize, C.light);
      const sTxt = txt(t('world.tabShop'), snapFont(Math.round(aucH * 0.34)), C.light);
      sTxt.anchor.set(0, 0.5);
      const sGrpW = sIconSize + 4 + sTxt.width;
      const shopW = Math.ceil(sGrpW) + 24;
      const shopBtn = sketchButton(shopW, aucH, seedFor(1, 1, shopW));
      shopBtn.x = aucBtn.x - shopW - 8; shopBtn.y = aucBtn.y;
      layer.addChild(shopBtn);
      const sGx = shopBtn.x + (shopW - sGrpW) / 2;
      sIcon.x = sGx; sIcon.y = shopBtn.y + (aucH - sIconSize) / 2;
      sTxt.x = sGx + sIconSize + 4; sTxt.y = shopBtn.y + aucH / 2;
      layer.addChild(sIcon); layer.addChild(sTxt);
      this.ctx.shopBtnRect = { x: shopBtn.x, y: shopBtn.y, w: shopW, h: aucH };

      // Per-resource production readout — centered between the back button and the shop
      // button, replacing the old "World" title text.
      const yieldRate = this.ctx.me?.yieldRate ?? {};
      const iconSize = Math.round(headerH * 0.34);
      const fontSize = snapFont(Math.round(headerH * 0.26));
      const gap = Math.round(headerH * 0.3);
      const cluster = new PIXI.Container();
      let cx = 0;
      for (const rt of ['ink', 'paper', 'graphite', 'metal', 'sticker']) {
        const rate = Math.round(yieldRate[rt] ?? 0);
        const tex = getResTexture(rt);
        if (tex) {
          const sp = new PIXI.Sprite(tex);
          sp.width = sp.height = iconSize;
          sp.x = cx; sp.y = -iconSize / 2;
          cluster.addChild(sp);
          cx += iconSize + 3;
        }
        const lbl = txt(`+${rate}`, fontSize, C.dark);
        lbl.anchor.set(0, 0.5); lbl.x = cx; lbl.y = 0;
        cluster.addChild(lbl);
        cx += lbl.width + gap;
      }
      cx -= gap;
      const leftBound = this.ctx.backRect.x + this.ctx.backRect.w + 8;
      const rightBound = shopBtn.x - 8;
      cluster.x = leftBound + Math.max(0, (rightBound - leftBound - cx) / 2);
      cluster.y = headerH / 2;

      // Independent background panel behind the resource cluster, distinguishing it from the
      // shared header-bar chrome instead of floating directly on it.
      const padX = 10, padY = Math.round(headerH * 0.14);
      const bgPanel = sketchPanel(cx + padX * 2, headerH - padY * 2, { fill: C.paper, border: C.mid, seed: seedFor(2, 0, cx) });
      bgPanel.x = cluster.x - padX; bgPanel.y = padY;
      layer.addChild(bgPanel);
      layer.addChild(cluster);
      // Tappable: opens the Territory Overview panel (SLG_DESIGN_LOG.md §26).
      this.ctx.resClusterRect = { x: bgPanel.x, y: bgPanel.y, w: cx + padX * 2, h: headerH - padY * 2 };
    }

    renderHud(): void {
      const hud = this.ctx.hudLayer;
      tearDownChildren(hud); // rebuilt every ~5s by the march poll → free resource-count Text textures
      const { w, h } = this.ctx;
      this.renderHeaderHud();

      // ── Bottom chat bar (§25): shows the latest world-chat message (sender + truncated
      // body), polled alongside marches — plus an unread badge vs the local "last seen" mark ──
      const chatPanel = sketchPanel(w, HUD_H, { fill: C.paper, border: C.mid, seed: seedFor(0, 0, w) });
      chatPanel.y = h - HUD_H;
      hud.addChild(chatPanel);
      const latest = this.ctx.worldChatLatest;
      const chatLbl = txt(
        latest ? `${latest.senderName}: ${latest.body.slice(0, 28)}` : t('world.chat'),
        FS.tiny, latest ? C.dark : C.mid,
      );
      chatLbl.anchor.set(0, 0.5);
      chatLbl.x = 14; chatLbl.y = h - HUD_H / 2;
      hud.addChild(chatLbl);
      if (this.ctx.worldChatUnread > 0) {
        const badgeLabel = this.ctx.worldChatUnread > 9 ? '9+' : String(this.ctx.worldChatUnread);
        const badge = sketchPanel(22, 18, { fill: C.red, border: C.dark, width: 1, seed: seedFor(2, 1, 22) });
        badge.x = 14 + chatLbl.width + 8; badge.y = h - HUD_H / 2 - 9;
        hud.addChild(badge);
        const badgeTxt = txt(badgeLabel, FS.micro, C.light, true);
        badgeTxt.anchor.set(0.5);
        badgeTxt.x = badge.x + 11; badgeTxt.y = badge.y + 9;
        hud.addChild(badgeTxt);
      }
      this.ctx.chatBarRect = { x: 0, y: h - HUD_H, w, h: HUD_H };

      // ── Left column, top-left: Zoom, stacked directly under the floating Back chip
      // (drawn separately on ctx.topLayer — see WorldMapRenderer). The auction button now
      // lives in the header bar itself (renderHeaderHud), far right. ──
      const colW = 176, colH = 68, colGap = 6; // 2x the original 88x34 footprint
      const colX = this.ctx.backRect.x || 8;
      const ly = this.ctx.backRect.y + this.ctx.backRect.h + colGap || 8;

      const zoomLabels: Record<number, string> = { 1: '×1', 2: '×2', 3: '×3' };
      const zoomBtn = sketchButton(colW, colH, seedFor(4, 2, colW));
      zoomBtn.x = colX; zoomBtn.y = ly;
      hud.addChild(zoomBtn);
      const zIcon = buildIcon('zoom', 32, C.light);
      const zTxt = txt(zoomLabels[this.ctx.zoom] ?? '', FS.heading, C.light);
      zTxt.anchor.set(0, 0.5);
      const zGrpW = 32 + 8 + zTxt.width;
      const zGx = zoomBtn.x + (colW - zGrpW) / 2;
      zIcon.x = zGx; zIcon.y = zoomBtn.y + (colH - 32) / 2;
      zTxt.x = zGx + 40; zTxt.y = zoomBtn.y + colH / 2;
      hud.addChild(zIcon); hud.addChild(zTxt);
      this.ctx.zoomBtnRect = { x: zoomBtn.x, y: zoomBtn.y, w: colW, h: colH };

      // ── Right column, top-right: status card → marches badge → World/info (passive state) ──
      // 2x the original 160-wide footprint (status card, marches badge/list, info button).
      const rightW = 320;
      const rx = w - rightW - 16;
      let ry = this.ctx.topInset + 16;

      if (this.ctx.me?.joined) {
        const cardH = 116;
        const card = sketchPanel(rightW, cardH, { fill: C.paper, border: C.mid, seed: seedFor(2, 5, rightW) });
        card.x = rx; card.y = ry;
        hud.addChild(card);

        const troops = this.ctx.me.troops ?? 0;
        const troopCap = this.ctx.me.troopCap ?? 0;
        const territory = this.ctx.me.territoryCount ?? 0;
        const line1 = `${t('world.troops')} ${troops}/${troopCap}  ${t('world.territory')} ${territory}`;
        const lbl1 = txt(line1, FS.bodyLg, C.dark);
        lbl1.x = rx + 16; lbl1.y = ry + 12;
        hud.addChild(lbl1);

        // Resource counts: hand-drawn motif icon (res_atlas, reused from the map tiles) + count,
        // replacing the earlier emoji glyphs that broke the notebook art style. Falls back to
        // emoji only while the atlas is still decoding (getResTexture null).
        const res = this.ctx.me.resources ?? {};
        const RES_EMOJI: Record<string, string> = { ink: '🖋️', paper: '📄', graphite: '✏️', metal: '🔩', sticker: '⭐' };
        const RES_ICON = 30;
        let ix = rx + 16;
        const resRowY = ry + 64;
        for (const rt of ['ink', 'paper', 'graphite', 'metal', 'sticker']) {
          if (res[rt] === undefined) continue;
          const tex = getResTexture(rt);
          if (tex) {
            const sp = new PIXI.Sprite(tex);
            sp.width = sp.height = RES_ICON;
            sp.x = ix; sp.y = resRowY - 6;
            hud.addChild(sp);
            ix += RES_ICON + 2;
            const cnt = txt(`${res[rt]}`, FS.bodyLg, C.dark);
            cnt.x = ix; cnt.y = resRowY;
            hud.addChild(cnt);
            ix += cnt.width + 16;
          } else {
            const lbl = txt(`${RES_EMOJI[rt]}${res[rt]}`, FS.bodyLg, C.dark);
            lbl.x = ix; lbl.y = resRowY;
            hud.addChild(lbl);
            ix += lbl.width + 16;
          }
        }
        ry += cardH + 12;
      }

      // Marches badge — collapsed by default (flag glyph + count); tap toggles the expanded
      // list (own marches only; G5: this.marches may also hold in-vision enemy marches, which
      // can't be recalled, hence the `mine !== false` filter).
      this.ctx.marchRowRects = [];
      const myMarches = this.ctx.marches.filter((m) => m.mine !== false);
      if (this.ctx.me?.joined) {
        const badgeH = 64;
        const badge = sketchButton(rightW, badgeH, seedFor(6, 1, rightW));
        badge.x = rx; badge.y = ry;
        hud.addChild(badge);
        const bIcon = buildIcon('flag', 28, C.light);
        bIcon.x = rx + 20; bIcon.y = ry + (badgeH - 28) / 2;
        hud.addChild(bIcon);
        const bTxt = txt(myMarches.length > 0 ? `${t('world.marchList')} (${myMarches.length})` : t('world.marchList'), FS.label, C.light);
        bTxt.anchor.set(0, 0.5);
        bTxt.x = rx + 60; bTxt.y = ry + badgeH / 2;
        hud.addChild(bTxt);
        this.ctx.marchBadgeRect = { x: badge.x, y: badge.y, w: rightW, h: badgeH };
        ry += badgeH + 12;

        if (this.ctx.marchesExpanded && myMarches.length > 0) {
          const MARCH_ROW_H = 44;
          const RECALL_W = 100;
          const MAX_VISIBLE_MARCHES = 5;
          const visibleMarches = myMarches.slice(0, MAX_VISIBLE_MARCHES);
          const overflowCount = myMarches.length - visibleMarches.length;
          const now = serverNow();
          const MARCH_KIND_ICON: Record<string, IconKind> = {
            attack: 'swords', reinforce: 'armor', return: 'replay', occupy: 'flag',
          };
          const listH = visibleMarches.length * MARCH_ROW_H + 12 + (overflowCount > 0 ? MARCH_ROW_H : 0);
          const listPanel = sketchPanel(rightW, listH, { fill: C.paper, border: C.mid, seed: seedFor(6, 2, rightW) });
          listPanel.x = rx; listPanel.y = ry;
          hud.addChild(listPanel);
          for (let i = 0; i < visibleMarches.length; i++) {
            const m = visibleMarches[i];
            const [tx, ty] = this.ctx.parseTileId(m.toTile);
            const remaining = Math.max(0, Math.ceil((m.arriveAt - now) / 1000));
            const rowY = listPanel.y + 6 + i * MARCH_ROW_H;
            const kindIc = buildIcon(MARCH_KIND_ICON[m.kind] ?? 'flag', 26, C.dark);
            kindIc.x = rx + 12; kindIc.y = rowY + 2;
            hud.addChild(kindIc);
            const rowLbl = txt(`(${tx},${ty})  ${remaining}s`, FS.bodyLg, C.dark);
            rowLbl.x = rx + 44; rowLbl.y = rowY + 4;
            hud.addChild(rowLbl);

            if (m.kind !== 'return') {
              const recallBtn = sketchPanel(RECALL_W, 36, { fill: C.accent, border: C.red, seed: seedFor(i, 99, RECALL_W) });
              recallBtn.x = rx + rightW - RECALL_W - 8; recallBtn.y = rowY;
              hud.addChild(recallBtn);
              const recallLbl = txt(t('world.recall'), FS.body, C.light);
              recallLbl.anchor.set(0.5, 0.5);
              recallLbl.x = recallBtn.x + RECALL_W / 2; recallLbl.y = recallBtn.y + 18;
              hud.addChild(recallLbl);
              this.ctx.marchRowRects.push({
                marchId: m.marchId,
                worldId: this.ctx.cb.worldId,
                destX: tx, destY: ty,
                rowRect: { x: rx, y: rowY, w: rightW - RECALL_W - 16, h: MARCH_ROW_H },
                recallRect: { x: recallBtn.x, y: recallBtn.y, w: RECALL_W, h: 36 },
                instantReturnRect: null,
              });
            } else {
              // 2026-08-01 (SLG_DESIGN_LOG §46): "pay coins, instantly complete" button — server computes the
              // authoritative cost from remaining travel time; this is only a display estimate (same client-side
              // serverNow() clock CityScene's speedup buttons already use).
              const INSTANT_RETURN_W = 190;
              const coins = Math.max(1, Math.ceil(remaining / MARCH_RETURN_SPEEDUP_SECS_PER_COIN));
              const instantBtn = sketchPanel(INSTANT_RETURN_W, 36, { fill: C.accent, border: C.mid, seed: seedFor(i, 98, INSTANT_RETURN_W) });
              instantBtn.x = rx + rightW - INSTANT_RETURN_W - 8; instantBtn.y = rowY;
              hud.addChild(instantBtn);
              const instantLbl = txt(t('world.instantReturn', { coins }), FS.body, C.light);
              instantLbl.anchor.set(0.5, 0.5);
              instantLbl.x = instantBtn.x + INSTANT_RETURN_W / 2; instantLbl.y = instantBtn.y + 18;
              hud.addChild(instantLbl);
              this.ctx.marchRowRects.push({
                marchId: m.marchId,
                worldId: this.ctx.cb.worldId,
                destX: tx, destY: ty,
                rowRect: { x: rx, y: rowY, w: rightW - INSTANT_RETURN_W - 16, h: MARCH_ROW_H },
                recallRect: null,
                instantReturnRect: { x: instantBtn.x, y: instantBtn.y, w: INSTANT_RETURN_W, h: 36 },
              });
            }
          }
          if (overflowCount > 0) {
            const overflowY = listPanel.y + 6 + visibleMarches.length * MARCH_ROW_H;
            const overflowLbl = txt(t('world.marchMore', { n: overflowCount }), FS.bodyLg, C.mid);
            overflowLbl.x = rx + 12; overflowLbl.y = overflowY + 4;
            hud.addChild(overflowLbl);
          }
          ry = listPanel.y + listH + 12;
        }

        // Battle-replays badge — sits directly below the marches badge; tapping opens the last-100 replay browser.
        const repH = 64;
        const repBadge = sketchPanel(rightW, repH, { fill: C.paper, border: C.mid, seed: seedFor(6, 3, rightW) });
        repBadge.x = rx; repBadge.y = ry;
        hud.addChild(repBadge);
        const repIcon = buildIcon('replay', 28, C.dark);
        repIcon.x = rx + 20; repIcon.y = ry + (repH - 28) / 2;
        hud.addChild(repIcon);
        const repTxt = txt(t('world.replays'), FS.label, C.dark);
        repTxt.anchor.set(0, 0.5);
        repTxt.x = rx + 60; repTxt.y = ry + repH / 2;
        hud.addChild(repTxt);
        this.ctx.replayBadgeRect = { x: repBadge.x, y: repBadge.y, w: rightW, h: repH };
        ry += repH + 12;
      } else {
        this.ctx.marchBadgeRect = { x: 0, y: 0, w: 0, h: 0 };
        this.ctx.replayBadgeRect = { x: 0, y: 0, w: 0, h: 0 };
      }
    }
  };
}
