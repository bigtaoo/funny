// WorldMap HUD: header-bar content (production readout + shop/auction entry points) and the
// persistent bottom HUD (chat bar, march badge, action buttons). Rebuilt wholesale on every
// ~5s march poll, so each renderer tears its layer down first.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../../i18n';
import {
  ui as C,
  txt,
  sketchPanel,
  sketchButton,
  seedFor,
  tearDownChildren,
} from '../../../render/sketchUi';
import { buildIcon } from '../../../render/icons';
import { FS } from '../../../render/fontScale';
import { serverNow } from '../../../net/serverClock';
import { dhmsFromMs } from '../logic/formatDuration';
import { awayCount, buildTeamRows, teamRowIcon } from '../logic/teamStatus';
import { MARCH_RETURN_SPEEDUP_SECS_PER_COIN } from '@nw/shared';
import { HUD_H } from '../logic/constants';
import type { IconKind } from '../../../render/icons';
import type { WorldMapPanelsCore } from './core';
import { renderHeaderHud } from './headerHud';

export interface HudHandlers {
  renderHud(): void;
}

export class HudPanel implements HudHandlers {
  constructor(private readonly core: WorldMapPanelsCore) {}

  renderHud(): void {
    const hud = this.core.ctx.hudLayer;
    tearDownChildren(hud); // rebuilt every ~5s by the march poll → free resource-count Text textures
    const { w, h } = this.core.ctx;
    renderHeaderHud(this.core.ctx);

    // ── Bottom chat bar (§25): shows the latest world-chat message (sender + truncated
    // body), polled alongside marches — plus an unread badge vs the local "last seen" mark ──
    const chatPanel = sketchPanel(w, HUD_H, {
      fill: C.paper,
      border: C.mid,
      seed: seedFor(0, 0, w),
    });
    chatPanel.y = h - HUD_H;
    hud.addChild(chatPanel);
    const latest = this.core.ctx.worldChatLatest;
    const chatLbl = txt(
      latest ? `${latest.senderName}: ${latest.body.slice(0, 28)}` : t('world.chat'),
      FS.tiny,
      latest ? C.dark : C.mid
    );
    chatLbl.anchor.set(0, 0.5);
    chatLbl.x = 14;
    chatLbl.y = h - HUD_H / 2;
    hud.addChild(chatLbl);
    if (this.core.ctx.worldChatUnread > 0) {
      const badgeLabel =
        this.core.ctx.worldChatUnread > 9 ? '9+' : String(this.core.ctx.worldChatUnread);
      const badge = sketchPanel(22, 18, {
        fill: C.red,
        border: C.dark,
        width: 1,
        seed: seedFor(2, 1, 22),
      });
      badge.x = 14 + chatLbl.width + 8;
      badge.y = h - HUD_H / 2 - 9;
      hud.addChild(badge);
      const badgeTxt = txt(badgeLabel, FS.micro, C.light, true);
      badgeTxt.anchor.set(0.5);
      badgeTxt.x = badge.x + 11;
      badgeTxt.y = badge.y + 9;
      hud.addChild(badgeTxt);
    }
    this.core.ctx.chatBarRect = { x: 0, y: h - HUD_H, w, h: HUD_H };

    // ── Left column, top-left: Zoom, stacked directly under the floating Back chip
    // (drawn separately on ctx.topLayer — see WorldMapRenderer). The auction button now
    // lives in the header bar itself (renderHeaderHud), far right. ──
    const colW = 176,
      colH = 68,
      colGap = 6; // 2x the original 88x34 footprint
    const colX = this.core.ctx.backRect.x || 8;
    // Below everything the top reserves, not just the bar: in portrait `topInset` also covers the
    // resource strip under it (WorldMapRenderer/build.ts), and anchoring off the back chip alone put
    // the zoom chip on top of that strip. Landscape has no strip, so this is the old value there.
    const ly = Math.max(this.core.ctx.topInset, this.core.ctx.backRect.y + this.core.ctx.backRect.h) + colGap || 8;

    const zoomLabels: Record<number, string> = { 1: '×1', 2: '×2', 3: '×3' };
    const zoomBtn = sketchButton(colW, colH, seedFor(4, 2, colW));
    zoomBtn.x = colX;
    zoomBtn.y = ly;
    hud.addChild(zoomBtn);
    const zIcon = buildIcon('zoom', 32, C.light);
    const zTxt = txt(zoomLabels[this.core.ctx.zoom] ?? '', FS.heading, C.light);
    zTxt.anchor.set(0, 0.5);
    const zGrpW = 32 + 8 + zTxt.width;
    const zGx = zoomBtn.x + (colW - zGrpW) / 2;
    zIcon.x = zGx;
    zIcon.y = zoomBtn.y + (colH - 32) / 2;
    zTxt.x = zGx + 40;
    zTxt.y = zoomBtn.y + colH / 2;
    hud.addChild(zIcon);
    hud.addChild(zTxt);
    this.core.ctx.zoomBtnRect = { x: zoomBtn.x, y: zoomBtn.y, w: colW, h: colH };

    // ── Right column, top-right: status card → marches badge → World/info (passive state) ──
    // 2x the original 160-wide footprint (status card, marches badge/list, info button).
    const rightW = 320;
    const rx = w - rightW - 16;
    let ry = this.core.ctx.topInset + 16;

    if (this.core.ctx.me?.joined) {
      // Resource stockpile totals moved up into the header production readout
      // (renderHeaderHud, 2026-08-09) — this card now only shows troops/territory.
      //
      // 2026-08-11 legibility pass (user screenshot: "portrait UI too hard to read"):
      // was a single FS.bodyLg sentence ("Troops 8040/10000  Territory 11") crammed into a
      // 56px-tall strip — at portrait's narrower design width that reads as one small,
      // undifferentiated line of digits. Split into two icon-led stat chips (same "dense
      // stats need cards, not a text line" call as the Territory Overview panel redesign
      // — see [[territory-overview-table-cards]]) so each number gets its own visual
      // weight and a scannable icon instead of competing for space in one sentence.
      const cardH = 88;
      const card = sketchPanel(rightW, cardH, {
        fill: C.paper,
        border: C.mid,
        seed: seedFor(2, 5, rightW),
      });
      card.x = rx;
      card.y = ry;
      hud.addChild(card);

      const troops = this.core.ctx.me.troops ?? 0;
      const troopCap = this.core.ctx.me.troopCap ?? 0;
      const territory = this.core.ctx.me.territoryCount ?? 0;
      const halfW = rightW / 2;
      const statIconSize = 30;
      const stats: { icon: IconKind; value: string; label: string }[] = [
        { icon: 'swords', value: `${troops}/${troopCap}`, label: t('world.troops') },
        { icon: 'castle', value: `${territory}`, label: t('world.territory') },
      ];
      stats.forEach((s, i) => {
        const colX = rx + i * halfW;
        const icon = buildIcon(s.icon, statIconSize, C.dark);
        icon.x = colX + 14;
        icon.y = ry + 14;
        hud.addChild(icon);
        const valLbl = txt(s.value, FS.heading, C.dark, true);
        valLbl.anchor.set(0, 0.5);
        valLbl.x = colX + 14 + statIconSize + 8;
        valLbl.y = ry + 14 + statIconSize / 2;
        // Shrink-to-fit inside the column: at a full troop cap the value is "10000/10000", which at
        // FS.heading is wider than the 160px half-card and used to run straight over the Territory
        // column beside it (2026-08-18 portrait screenshot pass). Scale rather than truncate — the
        // number is the point of the chip.
        const valMaxW = colX + halfW - 10 - valLbl.x;
        if (valMaxW > 0 && valLbl.width > valMaxW) valLbl.scale.set(valMaxW / valLbl.width);
        hud.addChild(valLbl);
        const capLbl = txt(s.label, FS.tiny, C.mid);
        capLbl.x = colX + 14;
        capLbl.y = ry + 14 + statIconSize + 8;
        hud.addChild(capLbl);
        if (i === 0) {
          // Column divider — y is card-relative, so it has to be offset by `ry` like everything
          // else in here; without that it drew up at the top of the screen behind the header
          // (same 2026-08-18 pass) and the card looked like it had no divider at all.
          const div = new PIXI.Graphics();
          div.lineStyle(1, C.mid, 0.5);
          div.moveTo(colX + halfW, ry + 10);
          div.lineTo(colX + halfW, ry + cardH - 10);
          hud.addChild(div);
        }
      });
      ry += cardH + 12;

      // ── Active buffs (S8-8 UI fix, 2026-08-08): the capital-protection shield and the
      // training-speedup buff both took effect server-side with no way to see them or how much
      // time is left — see baseProtectedUntil/speedupUntil (PlayerWorldView). One compact chip
      // (icon + countdown) per active buff, reusing the same glyphs the shop panel already uses
      // for these items (SPEEDUP_ICON_TIERS/PROTECTION_ICON_TIERS in shop.ts) so the HUD and the
      // shop read as the same visual language. ──
      const buffNow = serverNow();
      const buffs: { icon: IconKind; label: string }[] = [];
      const shieldUntil = this.core.ctx.me.baseProtectedUntil ?? 0;
      if (shieldUntil > buffNow) {
        // 天/时/分/秒 breakdown (2026-08-08 UI fix) — a bare "146282s" is unreadable; these
        // shields commonly run 8-24h+ so days/hours matter more than the leftover seconds.
        buffs.push({
          icon: 'armorHeavy',
          label: t('world.protected', dhmsFromMs(shieldUntil - buffNow)),
        });
      }
      const speedupUntil = this.core.ctx.me.speedupUntil ?? 0;
      if (speedupUntil > buffNow) {
        buffs.push({
          icon: 'hourglassMd',
          label: t('world.speedup', dhmsFromMs(speedupUntil - buffNow)),
        });
      }
      if (buffs.length > 0) {
        // 2026-08-09 UI fix: at FS.label (24px) with no wrap, the "Protected (1d 1h 41m 41s)" /
        // German "Geschützt (noch ...)" strings ran past the panel's right edge and got clipped
        // by the canvas bounds. Drop to a smaller font and give each label a wordWrapWidth
        // (icon column reserves 34px) so it wraps to 2 lines instead of overflowing; row height
        // is sized per-label from the actual wrapped text height so single-line locales (en/zh)
        // stay compact while German's longer strings get the extra room they need.
        const buffFont = FS.tiny;
        const buffLabelW = rightW - 34 - 12;
        const rendered = buffs.map((b) => {
          const bLbl = txt(b.label, buffFont, C.dark, false, buffLabelW);
          return { icon: b.icon, bLbl, rowH: Math.max(34, bLbl.height + 10) };
        });
        const buffPanelH = rendered.reduce((sum, r) => sum + r.rowH, 0) + 8;
        const buffPanel = sketchPanel(rightW, buffPanelH, {
          fill: C.paper,
          border: C.mid,
          seed: seedFor(2, 7, rightW),
        });
        buffPanel.x = rx;
        buffPanel.y = ry;
        hud.addChild(buffPanel);
        let rowY = buffPanel.y + 4;
        for (const r of rendered) {
          const bIcon = buildIcon(r.icon, 26, C.dark);
          bIcon.x = rx + 12;
          bIcon.y = rowY + (r.rowH - 26) / 2;
          hud.addChild(bIcon);
          r.bLbl.x = rx + 34;
          r.bLbl.y = rowY + (r.rowH - r.bLbl.height) / 2;
          hud.addChild(r.bLbl);
          rowY += r.rowH;
        }
        ry += buffPanelH + 12;
      }
    }

    // Team-info badge — collapsed by default; tap toggles the expanded team panel. Was the "march
    // list" until 2026-08-30: that list could only show teams currently IN TRANSIT, so a team holding
    // an occupation, parked in the field, injured, or simply idle at home had no row anywhere on the
    // map. Rows now come from logic/teamStatus.ts (one per formation template + one per flat-troop
    // march), and tapping one flies the camera to wherever that team actually is — its base, if home.
    this.core.ctx.teamRowRects = [];
    const now = serverNow();
    const rows = buildTeamRows(this.core.ctx, now);
    if (this.core.ctx.me?.joined) {
      const badgeH = 64;
      const badge = sketchButton(rightW, badgeH, seedFor(6, 1, rightW));
      badge.x = rx;
      badge.y = ry;
      hud.addChild(badge);
      const bIcon = buildIcon('swords', 28, C.light);
      bIcon.x = rx + 20;
      bIcon.y = ry + (badgeH - 28) / 2;
      hud.addChild(bIcon);
      // "away/total" rather than a bare count: the number that decides whether the panel is worth
      // opening is how many teams are OUT, and the total is the context that makes it mean something.
      // Suppressed until the teams fetch has landed — a count derived from marches alone would read
      // as "you have 1 team" to a player who has five (teamsLoaded, WorldMapNet.refreshTeams).
      const bTxt = txt(
        this.core.ctx.teamsLoaded && rows.length > 0
          ? `${t('world.teamPanel')} (${awayCount(rows)}/${rows.length})`
          : t('world.teamPanel'),
        FS.label,
        C.light
      );
      bTxt.anchor.set(0, 0.5);
      bTxt.x = rx + 60;
      bTxt.y = ry + badgeH / 2;
      hud.addChild(bTxt);
      this.core.ctx.teamBadgeRect = { x: badge.x, y: badge.y, w: rightW, h: badgeH };
      ry += badgeH + 12;

      if (this.core.ctx.teamPanelExpanded) {
        const MIN_ROW_H = 56;
        const MAX_VISIBLE_ROWS = 5;
        const visibleRows = rows.slice(0, MAX_VISIBLE_ROWS);
        const overflowCount = rows.length - visibleRows.length;
        // An empty panel still needs to say something, and "not fetched yet" vs "you genuinely have no
        // formations" are different answers the player acts on differently.
        const emptyLine = rows.length === 0
          ? (this.core.ctx.teamsLoaded ? t('world.team.noTeams') : t('city.military.teamLoading'))
          : null;

        // Measure-then-place (same shape as the buff rows above): a row's action button is sized to
        // its OWN label rather than to a per-kind constant, and the status text gets whatever width
        // the button leaves. Both are needed because the labels are localized — a fixed 118px
        // "recall station" button fits 召回驻军 and clips German's "Besatzung zurückrufen", and a
        // status line squeezed beside a wide button wraps to two lines, which a fixed row height then
        // laps over. So: button width follows the label (within a clamp), and row height follows the
        // wrapped status. Guarded per locale by test/ui/worldMapTeamPanelFit.ui.ts.
        const ACTION_MIN_W = 80;
        const ACTION_MAX_W = 168;
        const ACTION_H = 26;
        const rendered = visibleRows.map((row, i) => {
          const march = row.march;
          let actionLabel: string | null = null;
          let actionBorder: number = C.mid;
          if (march && march.kind !== 'return') {
            actionLabel = t('world.recall');
            actionBorder = C.red;
          } else if (march) {
            // 2026-08-01 (SLG_DESIGN_LOG §46): "pay coins, instantly complete" — the server computes the
            // authoritative cost from the remaining travel time; this is only a display estimate.
            const remaining = Math.max(0, Math.ceil((march.arriveAt - now) / 1000));
            actionLabel = t('world.instantReturn', {
              coins: Math.max(1, Math.ceil(remaining / MARCH_RETURN_SPEEDUP_SECS_PER_COIN)),
            });
          } else if (row.stationedTeamId) {
            // Deliberately the same verb as a march recall rather than world.actRecallStation's longer
            // tile-menu wording: the row's own status line already says this team is in the field.
            actionLabel = t('world.recall');
          }
          const btnLbl = actionLabel ? txt(actionLabel, FS.tiny, C.light) : null;
          const actionW = btnLbl
            ? Math.min(ACTION_MAX_W, Math.max(ACTION_MIN_W, Math.ceil(btnLbl.width) + 20))
            : 0;
          if (btnLbl && btnLbl.width > actionW - 12) btnLbl.scale.set((actionW - 12) / btnLbl.width);
          const statusLbl = txt(
            row.status,
            FS.tiny,
            row.state === 'home' ? C.mid : row.state === 'injured' ? C.red : C.dark,
            false,
            rightW - 24 - (actionW > 0 ? actionW + 8 : 0)
          );
          return {
            row, i, march, btnLbl, actionW, actionBorder, statusLbl,
            rowH: Math.max(MIN_ROW_H, 30 + statusLbl.height + 8),
          };
        });

        const listH =
          (emptyLine ? 40 : rendered.reduce((sum, r) => sum + r.rowH, 0)) + 12 +
          (overflowCount > 0 ? 30 : 0);
        const listPanel = sketchPanel(rightW, listH, {
          fill: C.paper,
          border: C.mid,
          seed: seedFor(6, 2, rightW),
        });
        listPanel.x = rx;
        listPanel.y = ry;
        hud.addChild(listPanel);

        if (emptyLine) {
          const lbl = txt(emptyLine, FS.tiny, C.mid, false, rightW - 24);
          lbl.x = rx + 12;
          lbl.y = listPanel.y + 12;
          hud.addChild(lbl);
        }

        let rowY = listPanel.y + 6;
        for (const r of rendered) {
          const { row, march, actionW } = r;
          const kindIc = buildIcon(teamRowIcon(row.state), 24, C.dark);
          kindIc.x = rx + 12;
          kindIc.y = rowY + 3;
          hud.addChild(kindIc);
          const nameLbl = txt(row.title, FS.body, C.dark, true);
          nameLbl.x = rx + 44;
          nameLbl.y = rowY + 3;
          hud.addChild(nameLbl);
          const troopsLbl = txt(t('world.team.committed').replace('{n}', String(row.troops)), FS.tiny, C.mid);
          troopsLbl.anchor.set(1, 0);
          troopsLbl.x = rx + rightW - 12;
          troopsLbl.y = rowY + 7;
          hud.addChild(troopsLbl);

          r.statusLbl.x = rx + 12;
          r.statusLbl.y = rowY + 30;
          hud.addChild(r.statusLbl);

          let actionRect: { x: number; y: number; w: number; h: number } | null = null;
          if (r.btnLbl) {
            const btn = sketchPanel(actionW, ACTION_H, {
              fill: C.accent,
              border: r.actionBorder,
              seed: seedFor(r.i, 99, actionW),
            });
            btn.x = rx + rightW - actionW - 8;
            btn.y = rowY + 26;
            hud.addChild(btn);
            r.btnLbl.anchor.set(0.5, 0.5);
            r.btnLbl.x = btn.x + actionW / 2;
            r.btnLbl.y = btn.y + ACTION_H / 2;
            hud.addChild(r.btnLbl);
            actionRect = { x: btn.x, y: btn.y, w: actionW, h: ACTION_H };
          }

          this.core.ctx.teamRowRects.push({
            marchId: march?.marchId ?? null,
            stationedTeamId: row.stationedTeamId,
            worldId: this.core.ctx.cb.worldId,
            jumpX: row.jumpX,
            jumpY: row.jumpY,
            // The row's own tap target stops where the action button starts, so "fly there" and
            // "recall" never fight over the same pixels.
            rowRect: { x: rx, y: rowY, w: rightW - (actionW > 0 ? actionW + 16 : 0), h: r.rowH },
            recallRect: march && march.kind !== 'return' ? actionRect : null,
            instantReturnRect: march && march.kind === 'return' ? actionRect : null,
            recallStationRect: !march && row.stationedTeamId ? actionRect : null,
          });
          rowY += r.rowH;
        }
        if (overflowCount > 0) {
          const overflowLbl = txt(t('world.teamMore', { n: overflowCount }), FS.tiny, C.mid);
          overflowLbl.x = rx + 12;
          overflowLbl.y = rowY + 4;
          hud.addChild(overflowLbl);
        }
        ry = listPanel.y + listH + 12;
      }

      // Battle-replays badge — sits directly below the team badge; tapping opens the last-100
      // replay browser. 2026-08-11 legibility pass: was the one badge in this stack still on the
      // low-contrast paper `sketchPanel` (dark text on light paper, easy to lose against the pale
      // map underneath) while its sibling above it (the team badge) already used the higher-contrast
      // `sketchButton` fill + light text — switched to match, so the two feel like one action group.
      const repH = 64;
      const repBadge = sketchButton(rightW, repH, seedFor(6, 3, rightW));
      repBadge.x = rx;
      repBadge.y = ry;
      hud.addChild(repBadge);
      const repIcon = buildIcon('replay', 28, C.light);
      repIcon.x = rx + 20;
      repIcon.y = ry + (repH - 28) / 2;
      hud.addChild(repIcon);
      const repTxt = txt(t('world.replays'), FS.label, C.light);
      repTxt.anchor.set(0, 0.5);
      repTxt.x = rx + 60;
      repTxt.y = ry + repH / 2;
      hud.addChild(repTxt);
      this.core.ctx.replayBadgeRect = { x: repBadge.x, y: repBadge.y, w: rightW, h: repH };
      ry += repH + 12;
    } else {
      this.core.ctx.teamBadgeRect = { x: 0, y: 0, w: 0, h: 0 };
      this.core.ctx.replayBadgeRect = { x: 0, y: 0, w: 0, h: 0 };
    }
  }
}
