// Layout domain: the main build() — header, hero start button, campaign/world
// pillars, right-side engagement strip, bottom nav — plus the VS overlay and the
// tap-routing handleDown() dispatcher and the local-AI match state machine
// (onStartPressed/matchFound). This is the bulk of the scene's visual layout.
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { SketchPen } from '../../render/sketch';
import { palette } from '../../render/theme';
import { buildIcon, IconKind } from '../../render/icons';
import { buildCoinIcon } from '../../render/coinIconAtlas';
import { buildWearOverlay } from '../../render/wearOverlay';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { BoilingSprite } from '../../render/boil';
import { buildAvatar } from '../../render/avatar';
import { StickmanRuntime } from '../../render/stickman/StickmanRuntime';
import { randomHeroAssetUrl } from '../../render/heroSilhouette';
import { fitContentToBox } from '../../render/fitToBox';
import { Rect } from '../../layout/ILayout';
import logoUrl from '../../assets/logo.png';
import {
  C, txt, fmtCoins, sketchPanel, drawBtn, buildBackground, randomAiName,
  type Constructor, type LobbySceneBaseCtor,
} from './base';

export interface BuildHandlers {
  build(): void;
  handleDown(x: number, y: number): void;
  onStartPressed(): void;
  matchFound(): void;
}

export function BuildMixin<TBase extends LobbySceneBaseCtor>(Base: TBase): TBase & Constructor<BuildHandlers> {
  return class extends Base {
    // ── Input ──────────────────────────────────────────────────────────────────

    handleDown(x: number, y: number): void {
      if (this.state !== 'idle') return;
      // First-time feature guide (§4.1): any tap dismisses it and continues navigation. Checked before other hits.
      if (this.guideLayer) {
        this.clearGuide();
        return;
      }
      // Season settlement modal (SE-6): dismiss button or anywhere on backdrop dismisses it.
      if (this.settlementLayer) {
        this.clearSettlement();
        return;
      }
      // Achievement-unlock toast tap → jump to the wall (S9-5b). Checked first so it wins over nav slots.
      const tr = this.toastRect;
      if (tr && x >= tr.x && x <= tr.x + tr.w && y >= tr.y && y <= tr.y + tr.h) {
        const open = this.cb.onOpenAchievements;
        this.clearToast();
        if (open) open();
        return;
      }
      const p = this.profileChipRect;
      if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) {
        this.cb.onOpenProfile();
        return;
      }
      if (x >= this.btnRect.x && x <= this.btnRect.x + this.btnRect.w &&
          y >= this.btnRect.y && y <= this.btnRect.y + this.btnRect.h) {
        this.onStartPressed();
        return;
      }
      const camp = this.campaignBtnRect;
      if (x >= camp.x && x <= camp.x + camp.w && y >= camp.y && y <= camp.y + camp.h) {
        this.cb.onOpenCampaign();
        return;
      }
      // World map (SLG) pillar — promoted out of the bottom nav into the main layout.
      const wp = this.worldPillarRect;
      if (wp.w > 0 && x >= wp.x && x <= wp.x + wp.w && y >= wp.y && y <= wp.y + wp.h) {
        // Soft gate (§4): chapter one not cleared → greyed out, tap shows bubble instead of entering.
        if (this.cb.worldLocked) { this.showInfoToast(t('lobby.world.locked')); return; }
        if (this.cb.onOpenWorld) this.cb.onOpenWorld();
        return;
      }
      const daily = this.dailyBtnRect;
      if (this.cb.onOpenDaily && daily.w > 0 &&
          x >= daily.x && x <= daily.x + daily.w && y >= daily.y && y <= daily.y + daily.h) {
        this.cb.onOpenDaily();
        return;
      }
      const ev = this.eventsBtnRect;
      if (this.cb.onOpenEvents && ev.w > 0 &&
          x >= ev.x && x <= ev.x + ev.w && y >= ev.y && y <= ev.y + ev.h) {
        this.cb.onOpenEvents();
        return;
      }
      const ml = this.mailStripRect;
      if (ml.w > 0 && x >= ml.x && x <= ml.x + ml.w && y >= ml.y && y <= ml.y + ml.h) {
        if (this.cb.onOpenMail) this.cb.onOpenMail();
        else if (this.cb.onOpenSocial) this.cb.onOpenSocial();
        return;
      }
      const ach = this.achieveStripRect;
      if (ach.w > 0 && x >= ach.x && x <= ach.x + ach.w && y >= ach.y && y <= ach.y + ach.h) {
        if (this.cb.onOpenAchievements) this.cb.onOpenAchievements();
        return;
      }
      const auc = this.auctionStripRect;
      if (auc.w > 0 && x >= auc.x && x <= auc.x + auc.w && y >= auc.y && y <= auc.y + auc.h) {
        if (this.cb.onOpenAuction) this.cb.onOpenAuction();
        return;
      }
      const acc = this.accountChipRect;
      if (acc && this.accountChipFn &&
          x >= acc.x && x <= acc.x + acc.w && y >= acc.y && y <= acc.y + acc.h) {
        this.accountChipFn();
        return;
      }
      const coinsChip = this.coinsChipRect;
      if (coinsChip && this.cb.onOpenRecharge &&
          x >= coinsChip.x && x <= coinsChip.x + coinsChip.w && y >= coinsChip.y && y <= coinsChip.y + coinsChip.h) {
        this.cb.onOpenRecharge();
        return;
      }
      const rankChip = this.rankChipRect;
      if (rankChip && this.cb.onOpenLeaderboard &&
          x >= rankChip.x && x <= rankChip.x + rankChip.w && y >= rankChip.y && y <= rankChip.y + rankChip.h) {
        this.cb.onOpenLeaderboard();
        return;
      }
      // Bottom-nav center slot is now "home" (the lobby itself) — current page, no-op.
      // Shop + social slots are only drawn when online (offline omits them entirely),
      // so a zero-width rect here means the slot is absent — guard with w > 0.
      const s = this.socialNavRect;
      if (s.w > 0 && x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
        if (this.cb.onOpenSocial) this.cb.onOpenSocial();
        else this.cb.onOpenRoom();
        return;
      }
      const sh = this.shopNavRect;
      if (sh.w > 0 && x >= sh.x && x <= sh.x + sh.w && y >= sh.y && y <= sh.y + sh.h) {
        this.cb.onOpenShop();
        return;
      }
      // Collection reads local save data → works offline; rect always assigned.
      // Stats is online-only now (§6 decision 6) → its rect is unassigned (w=0) offline.
      const cd = this.cardsNavRect;
      if (cd.w > 0 && x >= cd.x && x <= cd.x + cd.w && y >= cd.y && y <= cd.y + cd.h) {
        this.cb.onOpenCards();
        return;
      }
      const st = this.statsNavRect;
      if (st.w > 0 && x >= st.x && x <= st.x + st.w && y >= st.y && y <= st.y + st.h) {
        this.cb.onOpenStats();
        return;
      }
    }

    // ── Build ──────────────────────────────────────────────────────────────────

    build(): void {
      const { w, h } = this;

      // Background — procedural notebook paper (sketch.ts), baked once per size.
      this.container.addChild(buildBackground(w, h));

      // C-group background doodles (art-direction §6.2): scattered over the paper
      // at very low alpha, below the wear overlay and all UI content.
      const decoC = buildDecorCLayer(w, h);
      if (decoC) this.container.addChild(decoC);

      // Worn-notebook overlay (art-direction §3.1) — faint grain/creases over the
      // page, below the header/panels so it never hurts UI readability.
      const wear = buildWearOverlay(w, h);
      wear.alpha = 0.55;
      this.container.addChild(wear);

      // Header block — sized up slightly (0.14 → 0.16) to fit the brand mark
      // (shield-crest logo, ADR-027) alongside the "Nivara" title without
      // crowding the tagline row.
      const tbH = Math.round(h * 0.16);
      const titleBg = new PIXI.Graphics();
      titleBg.beginFill(C.dark);
      titleBg.drawRect(0, 0, w, tbH);
      titleBg.endFill();
      this.container.addChild(titleBg);

      const title = txt(t('lobby.brandTitle'), Math.round(h * 0.05), 0xffffff, true);
      title.anchor.set(0, 0.5);

      const subtitle = txt(t('lobby.subtitle'), Math.round(h * 0.022), C.light);
      subtitle.anchor.set(0.5, 0.5); subtitle.y = tbH * 0.78;
      this.container.addChild(subtitle);

      // Centre the whole logo+title lockup as one block on the bar's midline,
      // then hang the subtitle under the title's own centre (not the bar's —
      // the title is wider than the subtitle, so centring both on `w/2`
      // independently left the lockup looking shifted right).
      const logoSize = Math.round(tbH * 0.9);
      const logoGap = Math.round(w * 0.015);
      const lockupW = logoSize + logoGap + title.width;
      const lockupLeft = Math.round(w / 2 - lockupW / 2);
      const titleX = lockupLeft + logoSize + logoGap;

      const logo = PIXI.Sprite.from(logoUrl as string);
      logo.anchor.set(1, 0.5);
      logo.width = logoSize; logo.height = logoSize;
      logo.x = titleX - logoGap; logo.y = tbH * 0.45;
      this.container.addChild(logo);

      title.x = titleX; title.y = tbH * 0.45;
      this.container.addChild(title);

      subtitle.x = titleX + title.width / 2;

      // Top-left profile chip (avatar + name) — opens the personal settings screen.
      const av = Math.round(tbH * 0.46);
      const avX = Math.round(w * 0.03);
      const avY = Math.round(tbH * 0.5 - av / 2);
      const avatar = buildAvatar(av, this.cb.playerName, 21, this.cb.avatarId);
      avatar.x = avX; avatar.y = avY;
      this.container.addChild(avatar);

      const nameGap = Math.round(w * 0.02);
      const nameLabel = txt(this.cb.playerName, Math.round(tbH * 0.24), 0xffffff, true);
      nameLabel.anchor.set(0, 0.5);
      nameLabel.x = avX + av + nameGap;
      nameLabel.y = tbH * 0.5;
      // Keep the chip clear of the centred title.
      const nameMax = w * 0.36 - (av + nameGap);
      if (nameLabel.width > nameMax) nameLabel.scale.set(nameMax / nameLabel.width);
      this.container.addChild(nameLabel);

      const pad = Math.round(tbH * 0.12);
      this.profileChipRect = {
        x: avX - pad, y: avY - pad,
        w: av + nameGap + nameLabel.width + 2 * pad, h: av + 2 * pad,
      };

      // Boiling-line title underline (art-direction §5.4) — a hand-drawn marker
      // stroke that subtly wobbles ~8fps. Cycles baked variants; near-zero cost.
      const ulW = Math.min(w * 0.6, title.width * 1.15);
      const ulH = Math.round(h * 0.02);
      this.titleBoil = new BoilingSprite(ulW, ulH, (pen) => {
        pen.stroke(
          [{ x: 2, y: ulH * 0.5 }, { x: ulW - 2, y: ulH * 0.5 }],
          { color: palette.marker, width: Math.max(4, ulH * 0.5), taper: 0.6, double: false },
        );
      }, { tag: 'lobby-title', variants: 3, fps: 8 });
      this.titleBoil.x = title.x + title.width / 2 - ulW / 2;
      this.titleBoil.y = tbH * 0.45 + title.height / 2;
      this.container.addChild(this.titleBoil);

      // Top-right account chip (SA-4): offline → login/register entry; online →
      // server-authoritative ladder badge with a small logout affordance.
      const chipX = w - Math.round(w * 0.04);
      if (this.cb.offline) {
        const login = txt(t('auth.loginEntry'), Math.round(h * 0.024), C.gold, true);
        login.anchor.set(1, 0.5); login.x = chipX; login.y = tbH * 0.5;
        this.container.addChild(login);
        const pad = Math.round(h * 0.02);
        this.accountChipRect = {
          x: login.x - login.width - pad, y: tbH * 0.5 - login.height / 2 - pad,
          w: login.width + 2 * pad, h: login.height + 2 * pad,
        };
        this.accountChipFn = this.cb.onLogin ?? null;
      } else if (this.cb.pvp) {
        const pvp = this.cb.pvp;
        // Three stacked lines in the header's right column: coins · rank · logout.
        const hasLogout = !!this.cb.onLogout;
        const coinsY = tbH * 0.30;
        const rankY  = hasLogout ? tbH * 0.55 : tbH * 0.45;
        const outY   = tbH * 0.80;

        // Soft-currency balance (server-authoritative mirror) — only meaningful online.
        if (typeof this.cb.coins === 'number') {
          const coinLbl = txt(fmtCoins(this.cb.coins), Math.round(h * 0.022), C.gold, true);
          coinLbl.anchor.set(1, 0.5); coinLbl.x = chipX; coinLbl.y = coinsY;
          this.container.addChild(coinLbl);
          // Coin icon to the left of the number — same AI atlas glyph as the shop header (falls
          // back to the procedural buildIcon draw until coinIconAtlas finishes loading).
          const ci = Math.round(h * 0.032);
          const coinIcon = buildCoinIcon('coin', ci, C.gold);
          coinIcon.x = Math.round(chipX - coinLbl.width - Math.round(h * 0.01) - ci);
          coinIcon.y = Math.round(coinsY - ci / 2);
          this.container.addChild(coinIcon);
          if (this.cb.onOpenRecharge) {
            const cpad = Math.round(h * 0.012);
            this.coinsChipRect = {
              x: coinIcon.x - cpad, y: coinsY - ci / 2 - cpad,
              w: (chipX - coinIcon.x) + cpad, h: ci + 2 * cpad,
            };
          }
        }

        const rankName = t(('rank.' + pvp.rank) as TranslationKey);
        const badge = pvp.rank === 'unranked' ? rankName : `${rankName} · ${pvp.elo}`;
        const badgeLabel = txt(badge, Math.round(h * 0.022), C.light, true);
        badgeLabel.anchor.set(1, 0.5); badgeLabel.x = chipX; badgeLabel.y = rankY;
        this.container.addChild(badgeLabel);
        if (this.cb.onOpenLeaderboard) {
          const rpad = Math.round(h * 0.012);
          this.rankChipRect = {
            x: badgeLabel.x - badgeLabel.width - rpad, y: badgeLabel.y - badgeLabel.height / 2 - rpad,
            w: badgeLabel.width + 2 * rpad, h: badgeLabel.height + 2 * rpad,
          };
        }
        if (this.cb.onLogout) {
          const out = txt(t('auth.logout'), Math.round(h * 0.016), C.mid);
          out.anchor.set(1, 0.5); out.x = chipX; out.y = outY;
          this.container.addChild(out);
          const pad = Math.round(h * 0.012);
          this.accountChipRect = {
            x: out.x - out.width - pad, y: out.y - out.height / 2 - pad,
            w: out.width + 2 * pad, h: out.height + 2 * pad,
          };
          this.accountChipFn = this.cb.onLogout;
        }
      }

      // ── Main content stack ─────────────────────────────────────────────────
      // A vertically-centred column between the header and the bottom nav:
      //   1. Hero "start match" button (primary action)
      //   2. Two equal pillars: Campaign (PvE) | World map (SLG)
      //   3. Right-side vertical strip: Daily / Mail / Events / Achievements (P2, online only)
      const navH = Math.round(h * 0.105);

      // Right-side strip: present only when online (daily wired implies online).
      const hasSideStrip = !!this.cb.onOpenDaily && !this.cb.offline;
      const sideItemSz = hasSideStrip ? Math.round(h * 0.082) : 0;  // square icon cell
      const sideGap    = hasSideStrip ? Math.round(w * 0.018) : 0;

      // Content narrows to make room for the strip; left margin unchanged.
      const fullContentW = Math.round(w * 0.82);
      const contentX     = Math.round((w - fullContentW) / 2);
      const contentW     = fullContentW - sideItemSz - sideGap;
      const sideX        = contentX + contentW + sideGap;

      const heroH   = Math.round(h * 0.165);
      const pillarH = Math.round(h * 0.155);
      const gapA    = Math.round(h * 0.04);  // hero → pillars

      const stackH  = heroH + gapA + pillarH;
      const usableTop = tbH;
      const usableH   = (h - navH) - tbH;
      // Bias upward (0.40 instead of 0.5): push the hero up to close the large gap below the header.
      const startY = usableTop + Math.max(Math.round(h * 0.035), Math.round((usableH - stackH) * 0.40));

      const heroY    = startY;
      const pillarsY = heroY + heroH + gapA;

      // 1. Hero — start match. Offline → local AI match; online → PvP ranked.
      this.btnRect = { x: contentX, y: heroY, w: contentW, h: heroH };
      this.btnBg = new PIXI.Graphics();
      drawBtn(this.btnBg, contentW, heroH, true);
      this.btnBg.x = contentX; this.btnBg.y = heroY;
      this.container.addChild(this.btnBg);

      // Crossed-pencils motif stamped on the right of the hero (faint accent ink on
      // the dark fill) — adds content without a photo, off-centre to clear the label.
      const heroMotifS = Math.round(heroH * 1.05);
      const heroMotif = buildIcon('pencils', heroMotifS, C.accent);
      heroMotif.alpha = 0.22;
      heroMotif.x = Math.round(contentX + contentW - heroMotifS * 1.15);
      heroMotif.y = Math.round(heroY + heroH / 2 - heroMotifS / 2);
      this.container.addChild(heroMotif);

      this.btnLabel = txt(this.cb.offline ? t('lobby.startVsAI') : t('lobby.startMatch'), Math.round(heroH * 0.30), 0xffffff, true);
      this.btnLabel.anchor.set(0.5, 0.5);
      this.btnLabel.x = contentX + contentW / 2;
      this.btnLabel.y = heroY + heroH * 0.38;
      this.container.addChild(this.btnLabel);

      // Ambient character silhouette on the left of the hero (mirrors the pencils
      // motif above): a random playable unit, flat-black + faded, cycling through
      // random animation clips (§ hero-decoration). Loads async — appears a frame
      // or two after the rest of the button since the .tao bundle must be fetched.
      // Centred horizontally 1/3 of the way from the button's left edge to the
      // label's left edge (not flush against the edge) so it reads as a companion
      // beside the text.
      //
      // Sizing must be by the RENDERED PIXELS, not asset.naturalHeight: that value
      // is the skeleton *joint* extent, so head/foot/weapon art overhanging the
      // joints is invisible to it and each rig ends up a different on-screen height,
      // off-centre. Instead we measure the figure's true drawn bounds (unioned over
      // all clips → pose-stable, same basis for every rig) and fit it to exactly
      // 90% of the button height, centred on the button's centre. No ground shadow —
      // it floats inside the button (showShadow:false).
      const HERO_FIGURE_FRAC = 0.90;                            // silhouette height = 90% of button
      const heroFigureH    = Math.round(heroH * HERO_FIGURE_FRAC);   // outline-calibration hint only
      const labelLeftEdge  = this.btnLabel.x - this.btnLabel.width / 2;
      const heroFigureX    = Math.round(contentX + (labelLeftEdge - contentX) / 3);
      const heroFigureInsertAfter = heroMotif;
      StickmanRuntime.loadAsset(randomHeroAssetUrl(), heroFigureH).then(asset => {
        if (this.destroyed) return;
        const runtime = new StickmanRuntime(asset, { showShadow: false });
        runtime.setSilhouette(0x000000);
        runtime.container.alpha = 0.22;
        // Fit the true rendered extent to 90% of the button height, centred both
        // axes (fitContentToBox — measured box, never an assumed origin).
        const fit = fitContentToBox(
          runtime.getRenderedLocalBounds(),
          { top: heroY, height: heroH, centerX: heroFigureX },
          HERO_FIGURE_FRAC,
        );
        runtime.container.scale.set(fit.scale, fit.scale);
        runtime.container.x = fit.x;
        runtime.container.y = fit.y;
        const idx = this.container.getChildIndex(heroFigureInsertAfter);
        this.container.addChildAt(runtime.container, idx + 1);
        this.heroFigureClips = [...asset.clips.keys()];
        if (this.heroFigureClips.length) {
          runtime.play(this.heroFigureClips[Math.floor(Math.random() * this.heroFigureClips.length)]!);
        }
        this.heroFigureSwapTimer = 1.6 + Math.random() * 1.6;
        this.heroFigure = runtime;
      }).catch(() => { /* decorative-only: missing/broken .tao must not crash the lobby */ });

      const heroSubKey: TranslationKey = this.cb.offline
        ? 'lobby.match.subSolo'
        : (this.cb.online ? 'lobby.match.subRanked' : 'lobby.match.subAI');
      const heroSub = txt(t(heroSubKey), Math.round(heroH * 0.15), C.light);
      heroSub.anchor.set(0.5, 0.5);
      heroSub.x = contentX + contentW / 2;
      heroSub.y = heroY + heroH * 0.70;
      this.container.addChild(heroSub);

      // 2. Pillars: Campaign (gold, PvE) | World map (accent, SLG). The world map needs an account,
      // so it's hidden in offline mode — Campaign then takes the full content width.
      const showWorld = !this.cb.offline && !!this.cb.onOpenWorld;
      const pillarGap = Math.round(w * 0.025);
      const pw = showWorld ? Math.round((contentW - pillarGap) / 2) : contentW;

      this.campaignBtnRect = { x: contentX, y: pillarsY, w: pw, h: pillarH };
      this.drawPillar(contentX, pillarsY, pw, pillarH, C.gold, 'book',
        t('lobby.campaign'), t('lobby.campaign.sub'), 51);

      if (showWorld) {
        const worldX = contentX + pw + pillarGap;
        this.worldPillarRect = { x: worldX, y: pillarsY, w: pw, h: pillarH };
        // Soft gate (§4): chapter one not cleared → greyed accent + subtitle changed to "clear chapter one to unlock".
        const locked = !!this.cb.worldLocked;
        this.drawPillar(worldX, pillarsY, pw, pillarH, locked ? C.light : C.accent, 'castle',
          t('lobby.world'), locked ? t('lobby.world.locked') : t('lobby.world.sub'), 53);
      } else {
        this.worldPillarRect = { x: 0, y: 0, w: 0, h: 0 };
      }

      // 3. Right-side vertical strip — Daily / Mail / Events / Achievements (P2).
      // Replaces the old horizontal engagement chip row. Items are compact sketch
      // panels stacked vertically alongside the hero + pillars area, each with a
      // short 2-char label and a red dot when actionable.
      this.dailyBtnRect   = { x: 0, y: 0, w: 0, h: 0 };
      this.eventsBtnRect  = { x: 0, y: 0, w: 0, h: 0 };
      this.mailStripRect  = { x: 0, y: 0, w: 0, h: 0 };
      this.achieveStripRect = { x: 0, y: 0, w: 0, h: 0 };
      this.auctionStripRect = { x: 0, y: 0, w: 0, h: 0 };
      if (hasSideStrip) {
        const hasEvents  = !!this.cb.onOpenEvents && this.eventsAvailable;
        const hasMail    = !!(this.cb.onOpenMail ?? this.cb.onOpenSocial);
        const hasAchieve = !!this.cb.onOpenAchievements;
        const hasAuction = !!this.cb.onOpenAuction;

        type StripEntry = { label: string; border: number; seed: number; tag: 'daily' | 'mail' | 'events' | 'achieve' | 'auction' };
        const entries: StripEntry[] = [];
        entries.push({ label: t('daily.title'),        border: C.gold,  seed: 71, tag: 'daily'   });
        if (hasMail)    entries.push({ label: t('lobby.strip.mail'),   border: C.gold,  seed: 72, tag: 'mail'    });
        if (hasEvents)  entries.push({ label: t('lobby.strip.events'), border: C.red,   seed: 73, tag: 'events'  });
        if (hasAchieve) entries.push({ label: t('lobby.strip.achieve'),border: C.accent,seed: 74, tag: 'achieve' });
        if (hasAuction) entries.push({ label: t('lobby.strip.auction'),border: C.green, seed: 75, tag: 'auction' });

        const itemGap  = Math.round(h * 0.014);
        const totalH   = entries.length * sideItemSz + (entries.length - 1) * itemGap;
        // Vertically centre the strip within the hero+pillars block.
        const stripTopY = Math.round(heroY + (stackH - totalH) / 2);
        const fontSize  = Math.round(sideItemSz * 0.30);

        entries.forEach((entry, i) => {
          const iy = stripTopY + i * (sideItemSz + itemGap);
          const bg = sketchPanel(sideItemSz, sideItemSz, { fill: C.paper, border: entry.border, width: 1.8, seed: entry.seed });
          bg.x = sideX; bg.y = iy;
          this.container.addChild(bg);

          const lbl = txt(entry.label, fontSize, C.dark, true);
          lbl.anchor.set(0.5, 0.5);
          lbl.x = sideX + sideItemSz / 2; lbl.y = iy + sideItemSz / 2;
          // Scale down if label doesn't fit (e.g. longer EN strings).
          const maxW = sideItemSz * 0.88;
          if (lbl.width > maxW) lbl.scale.set(maxW / lbl.width);
          this.container.addChild(lbl);

          const rect: Rect = { x: sideX, y: iy, w: sideItemSz, h: sideItemSz };
          switch (entry.tag) {
            case 'daily':   this.dailyBtnRect   = rect; break;
            case 'mail':    this.mailStripRect   = rect; break;
            case 'events':  this.eventsBtnRect   = rect; break;
            case 'achieve': this.achieveStripRect = rect; break;
            case 'auction': this.auctionStripRect = rect; break;
          }
        });

        // Badge layer for cheap dot redraws (no full rebuild needed for state changes).
        this.sideStripBadgeLayer = new PIXI.Container();
        this.container.addChild(this.sideStripBadgeLayer);
        this.drawSideStripBadges();
      }

      // Bottom nav (IA redesign §3). Five fixed slots; the center home slot is the
      // lobby itself (world map promoted to a pillar above), rendered active + no-op.
      // Shop/stats/social need an account → greyed (not removed) in offline mode so the
      // tab layout stays stable; collection + home stay live.
      const navBg = new PIXI.Graphics();
      navBg.beginFill(C.dark, 0.9);
      navBg.drawRect(0, h - navH, w, navH);
      navBg.endFill();
      this.container.addChild(navBg);

      // Reset gated rects so a stale rect can't be hit when its slot is disabled.
      this.cardsNavRect  = { x: 0, y: 0, w: 0, h: 0 };
      this.statsNavRect  = { x: 0, y: 0, w: 0, h: 0 };
      this.shopNavRect   = { x: 0, y: 0, w: 0, h: 0 };
      this.socialNavRect = { x: 0, y: 0, w: 0, h: 0 };

      // IA redesign (LOBBY_IA_REDESIGN §3): fixed 5 tabs, grouped by intent —
      //   collection(cards) · shop · home(center) · stats · social.
      // Offline: shop/stats/social entire tabs greyed (§6 decision 6: no entry, no re-tutorial);
      // collection (reads local save) and home remain usable.
      interface NavSlot { name: string; icon: IconKind; color: number; active?: boolean; disabled?: boolean; assign?: (r: Rect) => void; }
      const off = !!this.cb.offline;
      const slots: NavSlot[] = [
        { name: t('lobby.nav.cards'),  icon: 'book',   color: C.red,    assign: r => { this.cardsNavRect = r; } },
        { name: t('lobby.nav.shop'),   icon: 'coin',   color: C.green,  disabled: off, assign: r => { this.shopNavRect = r; } },
        { name: t('lobby.nav.home'),   icon: 'home',   color: C.accent, active: true },
        { name: t('lobby.nav.stats'), icon: 'trophy', color: C.accent, disabled: off, assign: r => { this.statsNavRect = r; } },
        { name: t('lobby.nav.social'), icon: 'globe',  color: C.gold,   disabled: off, assign: r => { this.socialNavRect = r; } },
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

        const navLabel = txt(slot.name, Math.round(navH * 0.20), active ? 0xffffff : C.light, active);
        navLabel.anchor.set(0.5, 0);
        navLabel.alpha = disabled ? 0.4 : (active ? 1.0 : 0.78);
        navLabel.x = slotX; navLabel.y = labelTopY;
        navBg.addChild(navLabel);

        // Disabled slots render greyed but receive no hit rect (tap = no-op).
        if (!disabled) slot.assign?.({ x: i * slotW, y: navTop, w: slotW, h: navH });
      });

      // Aggregate social unread badge (count bubble) drawn over the social slot.
      // Lives in its own layer so applySocialBadge() can refresh it cheaply.
      this.socialBadgeLayer = new PIXI.Container();
      navBg.addChild(this.socialBadgeLayer);
      this.drawSocialBadge();

      // Achievement claimable dot over the stats slot (its own layer for cheap refresh).
      this.achievementBadgeLayer = new PIXI.Container();
      navBg.addChild(this.achievementBadgeLayer);
      this.drawAchievementBadge();

      // Monthly/year card daily-reward-claimable dot over the shop slot (its own layer for cheap refresh).
      this.shopBadgeLayer = new PIXI.Container();
      navBg.addChild(this.shopBadgeLayer);
      this.drawShopBadge();

      // World-offline indicator over the world-map pillar (redrawn when applyWorldAvailable() is called).
      this.worldOfflineBadgeLayer = new PIXI.Container();
      this.container.addChild(this.worldOfflineBadgeLayer);
      this.drawWorldOfflineBadge();

      // VS overlay
      this.vsLayer = this.buildVsLayer(w, h);
      this.vsLayer.visible = false;
      this.container.addChild(this.vsLayer);
    }

    /**
     * A pillar card for the main lobby grid (Campaign / World map): hand-drawn panel +
     * coloured left-edge ink stroke + a SketchPen line-art icon, title and
     * subtitle. Shares the notebook-doodle language with the feature panels and
     * VS cards (icons replace the old emoji placeholders).
     */
    private drawPillar(
      x: number, y: number, w: number, h: number,
      accent: number, icon: IconKind, title: string, sub: string, seed: number,
    ): void {
      const bg = sketchPanel(w, h, { fill: C.paper, border: accent, width: 2.6, seed });
      bg.x = x; bg.y = y;
      this.container.addChild(bg);
      // Coloured ink accent stroke down the left edge.
      new SketchPen(bg, seed ^ 0x55).line(4, 6, 4, h - 6, { color: accent, width: 5, jitter: 0.8, taper: 0.85 });

      // Large hand-drawn motif filling the card's upper half (replaces the old small icon):
      // accent-ink colour at low alpha as a "card doodle"; the title text drawn over it remains legible.
      const iconSize = Math.round(h * 0.6);
      const glyph = buildIcon(icon, iconSize, accent);
      glyph.alpha = 0.6;
      glyph.x = Math.round(x + w / 2 - iconSize / 2);
      glyph.y = Math.round(y + h * 0.40 - iconSize / 2);
      this.container.addChild(glyph);

      const titleLbl = txt(title, Math.round(h * 0.22), C.dark, true);
      titleLbl.anchor.set(0.5, 0.5);
      titleLbl.x = x + w / 2; titleLbl.y = y + h * 0.70;
      this.container.addChild(titleLbl);

      const subLbl = txt(sub, Math.round(h * 0.12), C.mid);
      subLbl.anchor.set(0.5, 0.5);
      subLbl.x = x + w / 2; subLbl.y = y + h * 0.88;
      this.container.addChild(subLbl);
    }

    private buildVsLayer(w: number, h: number): PIXI.Container {
      const c = new PIXI.Container();

      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000, 0.82);
      dim.drawRect(0, 0, w, h);
      dim.endFill();
      c.addChild(dim);

      const cardW = Math.round(w * 0.62);
      const cardH = Math.round(h * 0.12);
      const cardX = (w - cardW) / 2;

      const youCard = this.buildPlayerCard(cardW, cardH, t('lobby.you'), C.accent);
      youCard.x = cardX; youCard.y = Math.round(h * 0.28);
      c.addChild(youCard);

      const vs = txt(t('lobby.vs'), Math.round(h * 0.09), C.gold, true);
      vs.anchor.set(0.5, 0.5); vs.x = w / 2; vs.y = h * 0.5;
      c.addChild(vs);

      const oppCard = this.buildPlayerCard(cardW, cardH, '', C.red);
      oppCard.x = cardX; oppCard.y = Math.round(h * 0.58);
      c.addChild(oppCard);
      this.oppLabel = oppCard.getChildByName('nameLabel') as PIXI.Text;

      const hint = txt(t('lobby.loading'), Math.round(h * 0.022), C.mid);
      hint.anchor.set(0.5, 0); hint.x = w / 2; hint.y = h * 0.8;
      c.addChild(hint);

      return c;
    }

    private buildPlayerCard(w: number, h: number, name: string, accentColor: number): PIXI.Container {
      // Seed by side colour so the you/opp cards scrawl differently.
      const bg = sketchPanel(w, h, { fill: C.paper, border: accentColor, width: 2.4, seed: accentColor });
      // Ink accent stroke down the left edge.
      new SketchPen(bg, accentColor ^ 0x55).line(4, 5, 4, h - 5, { color: accentColor, width: 5, jitter: 0.8, taper: 0.85 });
      const nameLabel = txt(name, Math.round(h * 0.45), C.dark, true);
      nameLabel.name = 'nameLabel'; nameLabel.anchor.set(0, 0.5);
      nameLabel.x = Math.round(w * 0.08); nameLabel.y = h / 2;
      bg.addChild(nameLabel);
      return bg;
    }

    onStartPressed(): void {
      // Online + logged in → real PvP ranked matchmaking (RoomScene searching flow).
      // Offline / no server → the local AI quick-match below.
      if (this.cb.online && this.cb.onStartRanked) {
        this.cb.onStartRanked();
        return;
      }
      this.state = 'matching'; this.matchTimer = 0; this.dotsTimer = 0; this.dotCount = 0;
      // Use the stored rect, not gfx.width — the sketch stroke overshoots the box,
      // so re-reading bounds would grow the button on every redraw.
      drawBtn(this.btnBg, this.btnRect.w, this.btnRect.h, false);
      this.btnLabel.text = t('lobby.matching') + '...';
    }

    matchFound(): void {
      this.state = 'vs'; this.vsTimer = 0;
      this.opponentName  = randomAiName();
      this.oppLabel.text = this.opponentName;
      this.vsLayer.visible = true;
    }
  };
}
