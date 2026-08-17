// GachaScene page chrome: the scene header, the hub tab rail (sidebar in landscape, bottom nav
// in portrait) and the pool body — banner, pity readout, and the single/ten-pull buttons.
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import type { Rarity } from '../../game/meta/SaveData';
import { ui as C, txt } from '../../render/sketchUi';
import { gachaBannerTexture } from '../../render/gachaArt';
import { drawSceneHeader, drawHeaderCurrency, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { drawSidebarTabs, drawBottomNavTabs, sidebarNavW, bottomNavH, type HubTab } from '../../ui/widgets/HubTabs';
import { buildIcon } from '../../render/icons';
import { FS } from '../../render/fontScale';
import { serverNow } from '../../net/serverClock';
import { RARITY_COLOR, RARITY_STARS, FATE_COST } from './core';
import type { GachaSceneCore } from './core';

export interface PageHandlers {
  drawHeader(): number;
  drawSidebar(tbH: number): void;
  drawBody(tbH: number): void;
}

/** Header/sidebar/pool-body domain (see ../GachaScene.ts assembly + ./core.ts for the shared state). */
export class PagePanel implements PageHandlers {
  constructor(private readonly core: GachaSceneCore) {}

  drawHeader(): number {
    const { w, h } = this.core;
    const hdr = drawSceneHeader(this.core.container, w, h, t('gacha.title'), { accent: HEADER_ACCENT.spend, icon: 'gachaTabIcon' });
    const tbH = hdr.headerH;
    this.core.hits.push({ rect: hdr.backRect, fn: () => this.core.cb.onBack() });

    // Coin balance (top-right): shared header readout — identical across every scene.
    drawHeaderCurrency(this.core.container, w, tbH, this.core.cb.getCoins());

    return tbH;
  }

  /**
   * Shop group nav [Shop|Coins|Gacha|BattlePass] (LOBBY_IA_REDESIGN §9), Gacha active. Only drawn
   * when in the group context (openShop injected). Landscape: a vertical rail (`sidebarNavW`,
   * matching every other hub's left tab rail) — consumes no vertical space, drawBody shifts its
   * content start x instead. Portrait: a bottom nav bar instead (§18), drawn after drawBody (see
   * render()) so it's never visually run under by the body's own unbounded layout; its hits are
   * unshifted to the front so hit-testing matches that visual stacking.
   */
  drawSidebar(tbH: number): void {
    const core = this.core;
    if (!core.cb.openShop) return;
    const { w, h, landscape } = core;
    const tabs: HubTab[] = [{ label: t('shop.title'), active: false, icon: 'shopTabIcon', badge: core.cb.getShopBadge?.() ?? false }];
    const actions: Array<() => void> = [() => core.cb.openShop?.()];
    if (core.cb.openCoins) {
      tabs.push({ label: t('shop.coinsTab'), active: false, icon: 'coinTabIcon' });
      actions.push(() => core.cb.openCoins?.());
    }
    tabs.push({ label: t('gacha.title'), active: true, icon: 'gachaTabIcon' });
    actions.push(() => {});
    if (core.cb.openBattlePass) {
      tabs.push({ label: t('battlepass.title'), active: false, icon: 'battlepassTabIcon', badge: core.cb.getBattlePassBadge?.() ?? false });
      actions.push(() => core.cb.openBattlePass?.());
    }
    if (core.cb.openRecharge) {
      tabs.push({ label: t('recharge.title'), active: false, icon: 'rechargeTabIcon', badge: core.cb.getRechargeBadge?.() ?? false });
      actions.push(() => core.cb.openRecharge?.());
    }
    const onSelect = (i: number): void => actions[i]?.();
    if (!landscape) {
      const barH = bottomNavH(h);
      const { hits } = drawBottomNavTabs(core.container, w, h - barH, barH, tabs, onSelect);
      core.hits.unshift(...hits);
      return;
    }
    const sidebarW = sidebarNavW(w, h, true);
    const { hits } = drawSidebarTabs(core.container, sidebarW, tbH, h, tabs, onSelect);
    core.hits.push(...hits);
  }

  drawBody(tbH: number): void {
    const core = this.core;
    const { w, h } = core;
    const { x0: cx0, w: cw } = core.contentBounds();
    const centerX = cx0 + cw / 2;
    if (core.loading) {
      const lbl = txt(t('gacha.loading'), FS.title, C.mid);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = centerX;
      lbl.y = tbH + Math.round(h * 0.2);
      core.container.addChild(lbl);
      return;
    }
    if (!core.pool) {
      const lbl = txt(t('gacha.error'), FS.title, C.mid);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = centerX;
      lbl.y = tbH + Math.round(h * 0.2);
      core.container.addChild(lbl);
      return;
    }

    const pool = core.pool;

    // Pool selector (GACHA_DESIGN §2.2): one tab per pool (standard + active limited). Only shown when >1 pool.
    let selH = 0;
    if (core.pools.length > 1) {
      selH = Math.round(h * 0.055);
      const gap = Math.round(cw * 0.02);
      const totalW = Math.round(cw * 0.9);
      const tabW = Math.round((totalW - gap * (core.pools.length - 1)) / core.pools.length);
      const tabH = Math.round(h * 0.042);
      const sy = tbH + Math.round(h * 0.008);
      let sx = cx0 + (cw - totalW) / 2;
      core.pools.forEach((p, i) => {
        const active = i === core.poolIdx;
        const label = p.limited ? p.name ?? t('gacha.pool.limited') : t('gacha.pool.standard');
        core.addButton(
          label,
          sx,
          sy,
          tabW,
          tabH,
          active ? C.dark : C.btnOff,
          active ? C.gold : C.light,
          () => {
            core.poolIdx = i;
            core.render();
          },
          !active,
        );
        sx += tabW + gap;
      });
    }

    // Banner image.
    const bannerW = Math.round(cw * 0.78);
    const bannerH = Math.round(h * 0.26);
    const bx = cx0 + (cw - bannerW) / 2;
    const by = tbH + selH + Math.round(h * 0.05);
    const bannerTex = gachaBannerTexture(pool.id);
    const bannerSpr = new PIXI.Sprite(bannerTex);
    bannerSpr.x = bx;
    bannerSpr.y = by;
    bannerSpr.width = bannerW;
    bannerSpr.height = bannerH;
    core.container.addChild(bannerSpr);

    // Pool-type badge (banner top-left): limited → gold star, standard → gacha capsule.
    const poolBadge = buildIcon(pool.limited ? 'star' : 'capsule', Math.round(h * 0.036), pool.limited ? C.gold : C.mid);
    poolBadge.x = bx + Math.round(w * 0.02);
    poolBadge.y = by + Math.round(h * 0.015);
    core.container.addChild(poolBadge);

    // Limited / custom pool expiry countdown (banner bottom-left). Server only serves in-window pools,
    // so this normally counts down; a cached pool that just lapsed shows "Ended".
    if (pool.limited && pool.endAt) {
      const remain = pool.endAt - serverNow();
      const cdLabel =
        remain <= 0
          ? t('gacha.pool.ended')
          : t('gacha.pool.endsIn', {
              d: Math.floor(remain / 86_400_000),
              h: Math.floor((remain % 86_400_000) / 3_600_000),
            });
      const cd = txt(cdLabel, FS.body, remain <= 0 ? C.mid : C.gold, true);
      cd.anchor.set(0, 1);
      cd.x = bx + Math.round(w * 0.02);
      cd.y = by + bannerH - Math.round(h * 0.015);
      core.container.addChild(cd);
    }

    // Rarity legend: N star-pips per rarity (1..4), tinted by rarity colour.
    const dotR = Math.round(h * 0.012);
    const order: Rarity[] = ['common', 'rare', 'epic', 'legendary'];
    const legendY = by + bannerH * 0.68;
    const legendGap = bannerW / (order.length + 1);
    // Size stars so a full 4-pip row fits within ~82% of the inter-group gap.
    const starSz = Math.max(6, Math.min(Math.round(dotR * 1.8), Math.floor((legendGap * 0.82) / 4) - 2));
    order.forEach((rar, i) => {
      const cx = bx + legendGap * (i + 1);
      const n = RARITY_STARS[rar];
      const rowW = n * starSz + (n - 1) * 2;
      const starY = legendY - Math.round(h * 0.02) - starSz / 2;
      let sxp = cx - rowW / 2;
      for (let k = 0; k < n; k++) {
        const st = buildIcon('star', starSz, RARITY_COLOR[rar]);
        st.x = sxp;
        st.y = starY;
        core.container.addChild(st);
        sxp += starSz + 2;
      }
      const lbl = txt(t(('rarity.' + rar) as TranslationKey), FS.body, C.mid);
      lbl.anchor.set(0.5, 0);
      lbl.x = cx;
      lbl.y = legendY;
      core.container.addChild(lbl);
    });

    // Odds detail button (L1-3, Apple 3.1.1) — top-right of the banner.
    const oddsLbl = txt('ⓘ ' + t('gacha.oddsDetail.button'), FS.label, C.accent, true);
    oddsLbl.anchor.set(1, 0);
    oddsLbl.x = bx + bannerW - Math.round(w * 0.02);
    oddsLbl.y = by + Math.round(h * 0.015);
    core.container.addChild(oddsLbl);
    const oPad = Math.round(h * 0.012);
    core.hits.push({
      rect: { x: oddsLbl.x - oddsLbl.width - oPad, y: oddsLbl.y - oPad, w: oddsLbl.width + 2 * oPad, h: oddsLbl.height + 2 * oPad },
      fn: () => {
        core.oddsOpen = true;
        core.render();
      },
    });

    // Pity progress.
    const pityMax = pool.pityThreshold ?? 0;
    if (pityMax > 0) {
      const cur = core.cb.getPity(pool.id);
      const pity = txt(t('gacha.pity', { cur, max: pityMax }), FS.heading, C.dark, true);
      pity.anchor.set(0.5, 0.5);
      pity.x = centerX;
      pity.y = by + bannerH + Math.round(h * 0.05);
      core.container.addChild(pity);

      const barW = Math.round(cw * 0.7);
      const barH = Math.round(h * 0.018);
      const barX = cx0 + (cw - barW) / 2;
      const barY = by + bannerH + Math.round(h * 0.08);
      const track = new PIXI.Graphics();
      track.beginFill(C.light);
      track.drawRoundedRect(0, 0, barW, barH, barH / 2);
      track.endFill();
      track.x = barX;
      track.y = barY;
      core.container.addChild(track);
      const frac = Math.max(0, Math.min(1, cur / pityMax));
      if (frac > 0) {
        const fill = new PIXI.Graphics();
        fill.beginFill(C.gold);
        fill.drawRoundedRect(0, 0, Math.round(barW * frac), barH, barH / 2);
        fill.endFill();
        fill.x = barX;
        fill.y = barY;
        core.container.addChild(fill);
      }
    }

    // Draw buttons.
    const btnW = Math.round(cw * 0.78);
    const btnH = Math.round(h * 0.092);
    const btnX = cx0 + (cw - btnW) / 2;
    let btnY = Math.round(h * 0.68);
    const single = pool.costSingle;
    const ten = pool.costTen ?? pool.costSingle * 10;
    const canSingle = !core.bt.busy && core.cb.getCoins() >= single;
    const canTen = !core.bt.busy && core.cb.getCoins() >= ten;

    core.addButton(
      t('gacha.drawOne', { cost: single }),
      btnX,
      btnY,
      btnW,
      btnH,
      canSingle ? C.dark : C.btnOff,
      canSingle ? C.accent : C.light,
      () => void core.onDraw(1),
      canSingle,
    );
    btnY += btnH + Math.round(h * 0.025);
    core.addButton(
      t('gacha.drawTen', { cost: ten }),
      btnX,
      btnY,
      btnW,
      btnH,
      canTen ? C.dark : C.btnOff,
      canTen ? C.gold : C.light,
      () => void core.onDraw(10),
      canTen,
    );

    // Fate Points (GACHA_DESIGN §7): shown on limited pools; redeem when at the threshold.
    if (pool.limited && pool.featuredLegendary) {
      const fate = core.cb.getFatePoints();
      const cost = FATE_COST;
      btnY += btnH + Math.round(h * 0.02);
      const fateLbl = txt(t('gacha.fate.balance', { cur: fate, cost }), FS.label, C.dark, true);
      fateLbl.anchor.set(0, 0.5);
      fateLbl.x = btnX;
      fateLbl.y = btnY + btnH * 0.28;
      core.container.addChild(fateLbl);
      const canRedeem = !core.bt.busy && fate >= cost;
      const rW = Math.round(btnW * 0.4);
      core.addButton(
        t('gacha.fate.redeem'),
        btnX + btnW - rW,
        btnY,
        rW,
        Math.round(btnH * 0.6),
        canRedeem ? C.accent : C.btnOff,
        canRedeem ? C.gold : C.light,
        () => void core.onRedeemFate(),
        canRedeem,
      );
    }
  }
}
