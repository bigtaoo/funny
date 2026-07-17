// Badge/notification domain: the small red-dot indicators over the social/stats
// nav slots and the right-side strip, plus the worldsvc-offline tag on the world
// pillar and the events-strip visibility toggle (which needs a full rebuild()).
import * as PIXI from 'pixi.js-legacy';
import { tearDownChildren } from '../../render/sketchUi';
import { Rect } from '../../layout/ILayout';
import { C, txt, type Constructor, type LobbySceneBaseCtor } from './base';
import { snapFont } from '../../render/fontScale';

export interface BadgesHandlers {
  applySocialBadge(total: number): void;
  applyAchievementBadge(claimable: boolean): void;
  applyShopBadge(claimable: boolean): void;
  applyRetentionBadge(claimable: boolean): void;
  applyEventsAvailable(available: boolean): void;
  applyWorldAvailable(ok: boolean): void;
  drawSocialBadge(): void;
  drawAchievementBadge(): void;
  drawShopBadge(): void;
  drawWorldOfflineBadge(): void;
  drawSideStripBadges(): void;
}

export function BadgesMixin<TBase extends LobbySceneBaseCtor>(Base: TBase): TBase & Constructor<BadgesHandlers> {
  return class extends Base {
    /**
     * Update the aggregate social unread count (friends requests + unread chats +
     * unread mail). The core fetches GET /social/badges on lobby entry and forwards
     * push-driven increments here; we redraw just the badge dot, not the nav bar.
     */
    applySocialBadge(total: number): void {
      if (this.destroyed) return;
      this.socialBadge = Math.max(0, total | 0);
      this.drawSocialBadge();
      this.drawSideStripBadges();
    }

    /**
     * Mark whether any achievement tier is claimable. The core fetches
     * GET /achievements on lobby entry and computes hasClaimable; we redraw just
     * the dot on the stats nav slot, not the nav bar.
     */
    applyAchievementBadge(claimable: boolean): void {
      if (this.destroyed) return;
      this.achievementBadge = claimable;
      this.drawAchievementBadge();
      this.drawSideStripBadges();
    }

    /**
     * Mark whether the monthly/year card is active with today's daily reward still
     * unclaimed. The core derives this from the mirrored monetization save on lobby
     * entry (and after a claim); we redraw just the dot on the shop nav slot.
     */
    applyShopBadge(claimable: boolean): void {
      if (this.destroyed) return;
      if (this.shopBadge === claimable) return;
      this.shopBadge = claimable;
      this.drawShopBadge();
    }

    /** B5: mark whether any retention reward is claimable → red dot on the daily strip item. */
    applyRetentionBadge(claimable: boolean): void {
      if (this.destroyed) return;
      if (this.retentionBadge === claimable) return;
      this.retentionBadge = claimable;
      this.drawSideStripBadges();
    }

    /** B6: mark whether a live event window exists → show / hide the events entry button. */
    applyEventsAvailable(available: boolean): void {
      if (this.destroyed) return;
      if (this.eventsAvailable === available) return;
      this.eventsAvailable = available;
      this.rebuild();
    }

    /**
     * Full teardown + rebuild — needed when a layout element (strip item) appears or
     * changes, or when the coin-icon atlas finishes loading after the first draw (base.ts).
     */
    rebuild(): void {
      // titleBoil / heroFigure are Ticker.shared-driven and hold sprites that
      // tearDownChildren() is about to destroy — destroy them explicitly first,
      // same as the scene's own destroy(), so their next tick doesn't touch a
      // dead PIXI object (that used to freeze the scene's update loop).
      this.titleBoil?.destroy();
      this.titleBoil = null;
      this.heroFigure?.destroy();
      this.heroFigure = null;
      this.heroFigureClips = [];
      this.heroFigureSwapTimer = 0;
      tearDownChildren(this.container);
      this.toastLayer = null;
      this.settlementLayer = null;
      this.achievementBadgeLayer = null;
      this.shopBadgeLayer = null;
      this.socialBadgeLayer = null;
      this.sideStripBadgeLayer = null;
      this.build();
    }

    /** Draw (or clear) the social unread bubble at the top-right of the social nav dot. */
    drawSocialBadge(): void {
      const layer = this.socialBadgeLayer;
      if (!layer) return;
      layer.removeChildren();
      if (this.socialBadge <= 0) return;

      const s = this.socialNavRect;
      const navH = s.h;
      const dotR  = Math.round(navH * 0.17);
      const cx = s.x + s.w / 2 + dotR;
      const cy = s.y + navH / 2 - Math.round(navH * 0.18) - dotR;

      const label = this.socialBadge > 99 ? '99+' : String(this.socialBadge);
      const txtNode = txt(label, snapFont(Math.round(navH * 0.24)), 0xffffff, true);
      txtNode.anchor.set(0.5, 0.5);
      const r = Math.max(Math.round(navH * 0.16), txtNode.width / 2 + Math.round(navH * 0.08));

      const g = new PIXI.Graphics();
      g.beginFill(C.red);
      g.lineStyle(2, C.light, 0.9);
      g.drawCircle(cx, cy, r);
      g.endFill();
      layer.addChild(g);
      txtNode.x = cx; txtNode.y = cy;
      layer.addChild(txtNode);
    }

    /** Draw (or clear) a small red dot at the top-right of the stats nav dot when a reward is claimable. */
    drawAchievementBadge(): void {
      const layer = this.achievementBadgeLayer;
      if (!layer) return;
      layer.removeChildren();
      if (!this.achievementBadge) return;

      const s = this.statsNavRect;
      const navH = s.h;
      const dotR = Math.round(navH * 0.17);
      const cx = s.x + s.w / 2 + dotR;
      const cy = s.y + navH / 2 - Math.round(navH * 0.18) - dotR;
      const r = Math.round(navH * 0.12);

      const g = new PIXI.Graphics();
      g.beginFill(C.red);
      g.lineStyle(2, C.light, 0.9);
      g.drawCircle(cx, cy, r);
      g.endFill();
      layer.addChild(g);
    }

    /** Draw (or clear) a small red dot at the top-right of the shop nav slot when the card's daily reward is claimable. */
    drawShopBadge(): void {
      const layer = this.shopBadgeLayer;
      if (!layer) return;
      layer.removeChildren();
      if (!this.shopBadge) return;

      const s = this.shopNavRect;
      if (s.w <= 0) return;                            // shop slot greyed (offline) → no hit rect, no dot
      const navH = s.h;
      const dotR = Math.round(navH * 0.17);
      const cx = s.x + s.w / 2 + dotR;
      const cy = s.y + navH / 2 - Math.round(navH * 0.18) - dotR;
      const r = Math.round(navH * 0.12);

      const g = new PIXI.Graphics();
      g.beginFill(C.red);
      g.lineStyle(2, C.light, 0.9);
      g.drawCircle(cx, cy, r);
      g.endFill();
      layer.addChild(g);
    }

    /**
     * Called after a worldsvc reachability check (ping /health) resolves.
     * Shows a small "offline" badge on the world-map pillar when the service is down,
     * so developers see immediately that worldsvc isn't running — without having to
     * click the button and wait for the 3-second timeout.
     */
    applyWorldAvailable(ok: boolean): void {
      if (this.destroyed) return;
      this.worldOnline = ok;
      this.drawWorldOfflineBadge();
    }

    drawWorldOfflineBadge(): void {
      const layer = this.worldOfflineBadgeLayer;
      if (!layer) return;
      layer.removeChildren();
      if (this.worldOnline !== false) return;       // null (not yet checked) or true → nothing to show
      const p = this.worldPillarRect;
      if (p.w <= 0) return;                          // world pillar not present (offline mode)

      // Small "offline" tag pinned to the top-right corner of the world-map pillar.
      const tagH = Math.round(p.h * 0.22);
      const lbl = txt('offline', snapFont(Math.round(tagH * 0.7)), 0xffffff, true);
      const tagW = Math.round(lbl.width + tagH * 0.6);
      const tagX = p.x + p.w - tagW - Math.round(p.h * 0.08);
      const tagY = p.y + Math.round(p.h * 0.08);

      const bg = new PIXI.Graphics();
      bg.beginFill(C.red, 0.92).drawRoundedRect(tagX, tagY, tagW, tagH, Math.round(tagH * 0.3)).endFill();
      layer.addChild(bg);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = tagX + tagW / 2; lbl.y = tagY + tagH / 2;
      layer.addChild(lbl);
    }

    /** Draw (or clear) red dots on the right-side strip items. Cheap refresh — no layout rebuild. */
    drawSideStripBadges(): void {
      const layer = this.sideStripBadgeLayer;
      if (!layer) return;
      layer.removeChildren();

      const r = Math.round(this.h * 0.012);
      const drawDot = (rect: Rect): void => {
        if (rect.w <= 0) return;
        const g = new PIXI.Graphics();
        g.beginFill(C.red);
        g.lineStyle(Math.max(1, Math.round(r * 0.5)), 0xffffff, 0.9);
        g.drawCircle(rect.x + rect.w - r, rect.y + r, r);
        g.endFill();
        layer.addChild(g);
      };

      if (this.retentionBadge)      drawDot(this.dailyBtnRect);
      if (this.socialBadge > 0)     drawDot(this.mailStripRect);
      if (this.achievementBadge)    drawDot(this.achieveStripRect);
      // Events strip item has no badge (it's a contextual entry, not a reward).
    }
  };
}
