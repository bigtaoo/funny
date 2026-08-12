// Badge/notification domain: the small red-dot indicators over the social/stats
// nav slots and the right-side strip, plus the worldsvc-offline tag on the world
// pillar and the events-strip visibility toggle (which needs a full core.rebuild()).
import * as PIXI from 'pixi.js-legacy';
import { tearDownChildren } from '../../render/sketchUi';
import { Rect } from '../../layout/ILayout';
import { C, txt, type LobbySceneCore } from './core';
import { snapFont } from '../../render/fontScale';

export class BadgesPanel {
  constructor(private readonly core: LobbySceneCore) {}

  /**
   * Update the aggregate social unread count (friends requests + unread chats +
   * unread mail) for the social nav dot, and the mail-only unread count for the
   * dedicated mail strip item. The core fetches GET /social/badges on lobby entry
   * and forwards push-driven increments here; we redraw just the badge dots, not
   * the nav bar. Mail must stay a separate count — the strip item opens straight
   * into the mail list, so lighting it up on unrelated friend/chat unread makes it
   * look empty when the user taps in.
   */
  applySocialBadge(total: number, mail: number): void {
    const core = this.core;
    if (core.destroyed) return;
    core.socialBadge = Math.max(0, total | 0);
    core.mailBadge = Math.max(0, mail | 0);
    this.drawSocialBadge();
    this.drawSideStripBadges();
  }

  /**
   * Mark whether any achievement tier is claimable. The core fetches
   * GET /achievements on lobby entry and computes hasClaimable; we redraw just
   * the dot on the stats nav slot, not the nav bar.
   */
  applyAchievementBadge(claimable: boolean): void {
    const core = this.core;
    if (core.destroyed) return;
    core.achievementBadge = claimable;
    this.drawAchievementBadge();
    this.drawSideStripBadges();
  }

  /**
   * Mark whether the monthly/year card is active with today's daily reward still
   * unclaimed. The core derives this from the mirrored monetization save on lobby
   * entry (and after a claim); we redraw just the dot on the shop nav slot.
   */
  applyShopBadge(claimable: boolean): void {
    const core = this.core;
    if (core.destroyed) return;
    if (core.shopBadge === claimable) return;
    core.shopBadge = claimable;
    this.drawShopBadge();
  }

  /** B5: mark whether any retention reward is claimable → red dot on the daily strip item. */
  applyRetentionBadge(claimable: boolean): void {
    const core = this.core;
    if (core.destroyed) return;
    if (core.retentionBadge === claimable) return;
    core.retentionBadge = claimable;
    this.drawSideStripBadges();
  }

  /** B6: mark whether a live event window exists → show / hide the events entry button. */
  applyEventsAvailable(available: boolean): void {
    const core = this.core;
    if (core.destroyed) return;
    if (core.eventsAvailable === available) return;
    core.eventsAvailable = available;
    core.rebuild();
  }

  /** Draw (or clear) the social unread bubble at the top-right of the social nav dot. */
  drawSocialBadge(): void {
    const core = this.core;
    const layer = core.socialBadgeLayer;
    if (!layer) return;
    tearDownChildren(layer);
    if (core.socialBadge <= 0) return;

    const s = core.socialNavRect;
    const navH = s.h;
    const dotR  = Math.round(navH * 0.17);
    const cx = s.x + s.w / 2 + dotR;
    const cy = s.y + navH / 2 - Math.round(navH * 0.18) - dotR;

    const label = core.socialBadge > 99 ? '99+' : String(core.socialBadge);
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
    const core = this.core;
    const layer = core.achievementBadgeLayer;
    if (!layer) return;
    tearDownChildren(layer);
    if (!core.achievementBadge) return;

    const s = core.statsNavRect;
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
    const core = this.core;
    const layer = core.shopBadgeLayer;
    if (!layer) return;
    tearDownChildren(layer);
    if (!core.shopBadge) return;

    const s = core.shopNavRect;
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
    const core = this.core;
    if (core.destroyed) return;
    core.worldOnline = ok;
    this.drawWorldOfflineBadge();
  }

  drawWorldOfflineBadge(): void {
    const core = this.core;
    const layer = core.worldOfflineBadgeLayer;
    if (!layer) return;
    tearDownChildren(layer);
    if (core.worldOnline !== false) return;       // null (not yet checked) or true → nothing to show
    const p = core.worldPillarRect;
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
    const core = this.core;
    const layer = core.sideStripBadgeLayer;
    if (!layer) return;
    tearDownChildren(layer);

    const r = Math.round(core.h * 0.012);
    const drawDot = (rect: Rect): void => {
      if (rect.w <= 0) return;
      const g = new PIXI.Graphics();
      g.beginFill(C.red);
      g.lineStyle(Math.max(1, Math.round(r * 0.5)), 0xffffff, 0.9);
      g.drawCircle(rect.x + rect.w - r, rect.y + r, r);
      g.endFill();
      layer.addChild(g);
    };

    if (core.retentionBadge)      drawDot(core.dailyBtnRect);
    if (core.mailBadge > 0)       drawDot(core.mailStripRect);
    // Events / feedback strip items have no badge — feedback submission has no "unread" concept
    // (UI_DESIGN.md §4.1.1), events is a contextual entry rather than a reward.
  }
}
