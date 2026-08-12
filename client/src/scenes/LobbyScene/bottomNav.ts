// Bottom nav bar — split out of build.ts (2026-08-12, form ① independent function module per
// claudedocs/client-modules.md's split-form priority note) purely to keep build.ts under the
// 500-line convention. Draws the five fixed nav slots (cards/shop/home/stats/social), plus the
// badge layers (social/achievement/shop dots + the world-pillar offline tag) sitting on top of
// them. Only ever called from BuildPanel's own build(), so this takes `core`/`badges` explicitly
// instead of becoming its own domain class — it needs `badges` one-way to paint each dot into the
// layer it creates.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { buildIcon, IconKind } from '../../render/icons';
import { Rect } from '../../layout/ILayout';
import { C, txt, type LobbySceneCore } from './core';
import type { BadgesPanel } from './badges';
import { snapFont } from '../../render/fontScale';

export function drawBottomNav(core: LobbySceneCore, badges: BadgesPanel): void {
  const { w, h } = core;
  const navH = Math.round(h * 0.105);

  // Bottom nav (IA redesign §3). Five fixed slots; the center home slot is the
  // lobby itself (world map promoted to a pillar above), rendered active + no-op.
  // Shop/stats/social need an account → greyed (not removed) in offline mode so the
  // tab layout stays stable; collection + home stay live.
  const navBg = new PIXI.Graphics();
  navBg.beginFill(C.cover, 0.9);
  navBg.drawRect(0, h - navH, w, navH);
  navBg.endFill();
  core.container.addChild(navBg);

  // Reset gated rects so a stale rect can't be hit when its slot is disabled.
  core.cardsNavRect  = { x: 0, y: 0, w: 0, h: 0 };
  core.statsNavRect  = { x: 0, y: 0, w: 0, h: 0 };
  core.shopNavRect   = { x: 0, y: 0, w: 0, h: 0 };
  core.socialNavRect = { x: 0, y: 0, w: 0, h: 0 };

  // IA redesign (LOBBY_IA_REDESIGN §3): fixed 5 tabs, grouped by intent —
  //   collection(cards) · shop · home(center) · stats · social.
  // Offline: shop/stats/social entire tabs greyed (§6 decision 6: no entry, no re-tutorial);
  // collection (reads local save) and home remain usable.
  interface NavSlot { name: string; icon: IconKind; color: number; active?: boolean; disabled?: boolean; assign?: (r: Rect) => void; }
  const off = !!core.cb.offline;
  const slots: NavSlot[] = [
    { name: t('lobby.nav.cards'),  icon: 'book',   color: C.red,    assign: r => { core.cardsNavRect = r; } },
    { name: t('lobby.nav.shop'),   icon: 'coin',   color: C.green,  disabled: off, assign: r => { core.shopNavRect = r; } },
    { name: t('lobby.nav.home'),   icon: 'home',   color: C.accent, active: true },
    { name: t('lobby.nav.stats'), icon: 'trophy', color: C.accent, disabled: off, assign: r => { core.statsNavRect = r; } },
    { name: t('lobby.nav.social'), icon: 'globe',  color: C.gold,   disabled: off, assign: r => { core.socialNavRect = r; } },
  ];

  const n = slots.length;
  const iconS = Math.round(navH * 0.38);
  // Vertical layout: icon top at navTop + navH*0.10, label below icon + gap.
  const navTop = h - navH;
  const iconTopY = navTop + Math.round(navH * 0.10);
  const labelTopY = iconTopY + iconS + Math.round(navH * 0.04);

  slots.forEach((slot, i) => {
    const slotW = w / n;
    const slotX = i * slotW + slotW / 2;
    const active = !!slot.active;
    const disabled = !!slot.disabled;
    const iconColor = disabled ? C.mid : (active ? 0xffffff : C.light);

    // Active tab: a short accent bar at the top edge of the slot.
    if (active) {
      const barW = Math.round(slotW * 0.5);
      const bar = new PIXI.Graphics();
      bar.beginFill(slot.color, 0.95);
      bar.drawRect(slotX - barW / 2, navTop, barW, Math.max(2, Math.round(navH * 0.04)));
      bar.endFill();
      navBg.addChild(bar);
    }

    const icon = buildIcon(slot.icon, iconS, iconColor);
    icon.alpha = disabled ? 0.35 : (active ? 1.0 : 0.72);
    icon.x = Math.round(slotX - iconS / 2);
    icon.y = iconTopY;
    navBg.addChild(icon);

    const navLabel = txt(slot.name, snapFont(Math.round(navH * 0.20)), active ? 0xffffff : C.light, active);
    navLabel.anchor.set(0.5, 0);
    navLabel.alpha = disabled ? 0.4 : (active ? 1.0 : 0.78);
    navLabel.x = slotX; navLabel.y = labelTopY;
    navBg.addChild(navLabel);

    // Disabled slots render greyed but receive no hit rect (tap = no-op).
    if (!disabled) slot.assign?.({ x: i * slotW, y: navTop, w: slotW, h: navH });
  });

  // Aggregate social unread badge (count bubble) drawn over the social slot.
  // Lives in its own layer so applySocialBadge() can refresh it cheaply.
  core.socialBadgeLayer = new PIXI.Container();
  navBg.addChild(core.socialBadgeLayer);
  badges.drawSocialBadge();

  // Achievement claimable dot over the stats slot (its own layer for cheap refresh).
  core.achievementBadgeLayer = new PIXI.Container();
  navBg.addChild(core.achievementBadgeLayer);
  badges.drawAchievementBadge();

  // Monthly/year card daily-reward-claimable dot over the shop slot (its own layer for cheap refresh).
  core.shopBadgeLayer = new PIXI.Container();
  navBg.addChild(core.shopBadgeLayer);
  badges.drawShopBadge();

  // World-offline indicator over the world-map pillar (redrawn when applyWorldAvailable() is called).
  core.worldOfflineBadgeLayer = new PIXI.Container();
  core.container.addChild(core.worldOfflineBadgeLayer);
  badges.drawWorldOfflineBadge();
}
