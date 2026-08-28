// Building detail modal + train-troops modal + building bonus-line descriptions.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, scaledTxt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { formatDuration } from '../worldmap/logic/formatDuration';
import { serverNow } from '../../net/serverClock';
import type { BuildingKey } from '../../net/WorldApiClient';
import {
  DESK_MAX_LEVEL,
  CABINET_CAP_STEP,
  DRILL_TROOPCAP_STEP,
  DRILL_TRAIN_SPEED_STEP,
  baseDurabilityMax,
  ACADEMY_HP_STEP,
  ACADEMY_DAMAGE_STEP,
  buildingLevel,
  buildCost,
  buildTimeSec,
  buildGateReason,
  buildingYieldMult,
  buildingSelfYield,
  trainQueueMaxFor,
  BUILD_SPEEDUP_SECS_PER_COIN,
  satchelCarryCapFor,
  RESOURCE_TYPES,
  type ResourceType,
} from '@nw/shared';
import type { CitySceneCore } from './core';
import { renderTrainModal as renderTrainModalImpl } from './trainModal';

export interface ModalsHandlers {
  renderDetailModal(key: BuildingKey): void;
  renderTrainModal(): void;
  buildingBonusLines(
    key: BuildingKey,
    bld: Partial<Record<BuildingKey, number>> | undefined
  ): string[];
}

export class ModalsPanel implements ModalsHandlers {
  constructor(private readonly core: CitySceneCore) {}

  // ── Detail modal ──────────────────────────────────────────────────────────

  renderDetailModal(key: BuildingKey): void {
    const { w, h } = this.core;
    const bld = this.core.me?.buildings;
    const resources = this.core.me?.resources as Partial<Record<ResourceType, number>> | undefined;

    const lvl = buildingLevel(bld, key);
    const toLevel = lvl + 1;
    const gateReason = buildGateReason(bld, key, toLevel);
    const cost = buildCost(key, toLevel);
    const timeSec = buildTimeSec(key, toLevel);
    const queue = this.core.me?.buildQueue ?? [];
    const inQueue = queue.some((q) => q.key === key);
    // Only the HEAD entry gets a speed-up button (below), matching the build-queue bar. Deliberate,
    // not an oversight: `POST /world/build/speedup` takes only `{coins}` — the server ignores `key`
    // and burns coins × BUILD_SPEEDUP_SECS_PER_COIN off the queue **from the front**, spilling into
    // later entries. Pricing a tail entry by its own remaining time would charge for time the
    // server spends shortening a different build. Moot today (BUILD_QUEUE_SLOTS === 1), but this is
    // the spot to revisit if the paid 2nd slot (§6) ever ships.
    const headEntry = queue[0]?.key === key ? queue[0] : undefined;
    const canAfford =
      !gateReason &&
      Object.entries(cost).every(
        ([rt, need]) => (resources?.[rt as ResourceType] ?? 0) >= (need ?? 0)
      );
    const atMax = lvl >= DESK_MAX_LEVEL && key === 'desk';

    // Natural (unscaled) content size — laid out in a local frame, then scaled to
    // fill 80% of the constrained screen axis (popup-scale-to-80% convention).
    const bonusLines = this.buildingBonusLines(key, bld);
    const mw = Math.min(340, w - 24);
    const costEntries = RESOURCE_TYPES.map((rt) => ({ rt, need: cost[rt] ?? 0 })).filter(
      (e) => e.need > 0
    );
    const contentH =
      12 +
      28 +
      bonusLines.length * 16 +
      4 +
      (atMax ? 20 : 16 + (costEntries.length > 0 ? 16 : 0) + 24 + 36) +
      12;
    const mh = Math.min(contentH, h - 16);

    const scale = this.core.modalScaleFor(mw, mh);
    const screenW = mw * scale;
    const screenH = mh * scale;
    const screenX = (w - screenW) / 2;
    const screenY = Math.max(8, (h - screenH) / 2);

    // Dim covers the full screen; tapping it (outside interactive rects) closes the modal.
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
    this.core.container.addChild(dim);

    const panelRoot = new PIXI.Container();
    panelRoot.position.set(screenX, screenY);
    panelRoot.scale.set(scale);
    this.core.container.addChild(panelRoot);
    // Compensates PIXI.Text's raster blur from the panelRoot scale-up above — see scaledTxt().
    const st = scaledTxt(scale);

    const panel = sketchPanel(mw, mh, {
      fill: C.paper,
      border: C.accent,
      width: 2,
      seed: seedFor(0, 5, mw),
    });
    panelRoot.addChild(panel);

    let iy = 12;

    // Header — building glyph + name + level.
    const hIcon = this.core.bldIcon(key, 22, C.dark);
    hIcon.x = 10;
    hIcon.y = iy - 2;
    panelRoot.addChild(hIcon);
    const hdrTxt = st(
      `${t(`city.bld.${key}` as 'city.bld.desk')} ${t('city.lvlLabel').replace(
        '{lvl}',
        String(lvl)
      )}`,
      FS.small,
      C.dark,
      true
    );
    hdrTxt.x = 38;
    hdrTxt.y = iy;
    panelRoot.addChild(hdrTxt);
    iy += 28;

    for (const line of bonusLines) {
      const bl = st(line, FS.tiny, C.mid);
      bl.x = 10;
      bl.y = iy;
      panelRoot.addChild(bl);
      iy += 16;
    }
    iy += 4;

    if (atMax) {
      const ml = st(t('city.maxLevel'), FS.tiny, C.mid, true);
      ml.x = 10;
      ml.y = iy;
      panelRoot.addChild(ml);
    } else {
      const nextHdr = st(`→ Lv.${toLevel}`, FS.tiny, C.mid);
      nextHdr.x = 10;
      nextHdr.y = iy;
      panelRoot.addChild(nextHdr);
      iy += 16;

      if (costEntries.length > 0) {
        const costLbl = st(t('city.costLabel'), FS.tiny, C.dark);
        costLbl.x = 10;
        costLbl.y = iy;
        panelRoot.addChild(costLbl);
        let cxp = 10 + costLbl.width + 6;
        for (const { rt, need } of costEntries) {
          const ok = (resources?.[rt] ?? 0) >= need;
          const mi = this.core.resIcon(rt, 15);
          mi.x = cxp;
          mi.y = iy - 1;
          panelRoot.addChild(mi);
          cxp += 17;
          const nl = st(this.core.fmtNum(need), FS.tiny, ok ? C.dark : C.red);
          nl.x = cxp;
          nl.y = iy;
          panelRoot.addChild(nl);
          cxp += nl.width + 8;
        }
        iy += 16;
      }

      const timeLbl = st(t('city.timeLabel') + formatDuration(timeSec), FS.tiny, C.mid);
      timeLbl.x = 10;
      timeLbl.y = iy;
      panelRoot.addChild(timeLbl);
      iy += 24;

      if (gateReason?.includes('desk')) {
        const gl = st(t('city.deskGate').replace('{lvl}', String(toLevel)), FS.tiny, C.red);
        gl.x = 10;
        gl.y = iy;
        panelRoot.addChild(gl);
      } else if (inQueue) {
        const ql = st(t('city.upgrading'), FS.tiny, C.gold, true);
        ql.x = 10;
        ql.y = iy;
        panelRoot.addChild(ql);

        // Speed-up right here in the modal, on the same row as "建造中" — before this the only
        // speed-up button lived in the build-queue bar behind the modal, so the player had to
        // close the modal, tap it, and reopen. serverNow() for the same reason as actions.ts's
        // doSpeedup: the price shown must come off the server-corrected clock it charges against.
        const secsLeft = headEntry
          ? Math.max(0, Math.ceil((headEntry.completeAt - serverNow()) / 1000))
          : 0;
        if (secsLeft > 0) {
          // Same expression as renderBuildQueue's, deliberately: the two prices must agree.
          const coins = Math.ceil(secsLeft / BUILD_SPEEDUP_SECS_PER_COIN);
          const lbl = st(
            t('city.speedup').replace('{coins}', String(coins)),
            FS.tiny,
            C.dark,
            true
          );
          // scaledTxt() only raises the raster resolution — the Text keeps its unscaled
          // fontSize, so lbl.width is already in the panel's local frame.
          const btnW = Math.min(mw - 20, lbl.width + 16);
          const btnRectLocal = { x: mw - 10 - btnW, y: iy - 6, w: btnW, h: 28 };
          const g = sketchPanel(btnRectLocal.w, btnRectLocal.h, {
            fill: C.paper,
            border: C.gold,
            width: 1,
            seed: seedFor(btnRectLocal.x, btnRectLocal.y, btnRectLocal.w),
          });
          g.x = btnRectLocal.x;
          g.y = btnRectLocal.y;
          panelRoot.addChild(g);
          lbl.x = btnRectLocal.x + 8;
          lbl.y = btnRectLocal.y + (btnRectLocal.h - 16) / 2;
          panelRoot.addChild(lbl);

          const screenRect = this.core.toScreen(btnRectLocal, screenX, screenY, scale);
          this.core.hits.push({
            x: screenRect.x,
            y: screenRect.y,
            w: screenRect.w,
            h: screenRect.h,
            fn: () => void this.core.doSpeedup(key),
          });
        }
      } else {
        const btnRectLocal = { x: 10, y: iy, w: mw - 20, h: 32 };
        const g = sketchPanel(btnRectLocal.w, btnRectLocal.h, {
          fill: canAfford ? C.paper : C.btnDis,
          border: C.line,
          width: 1,
          seed: seedFor(btnRectLocal.x, btnRectLocal.y, btnRectLocal.w),
        });
        g.x = btnRectLocal.x;
        g.y = btnRectLocal.y;
        panelRoot.addChild(g);
        const lbl = st(t('city.upgrade'), FS.tiny, canAfford ? C.dark : C.mid, true);
        lbl.x = btnRectLocal.x + 8;
        lbl.y = btnRectLocal.y + (btnRectLocal.h - 16) / 2;
        panelRoot.addChild(lbl);

        const screenRect = this.core.toScreen(btnRectLocal, screenX, screenY, scale);
        this.core.hits.push({
          x: screenRect.x,
          y: screenRect.y,
          w: screenRect.w,
          h: screenRect.h,
          fn: canAfford
            ? () => void this.core.doUpgrade(key)
            : () => this.core.showToast(t('city.err.noResources'), C.red),
        });
        iy += 36;
      }
    }

    // Close on tap-outside — pushed LAST so panel buttons above take priority.
    this.core.hits.push({
      x: 0,
      y: 0,
      w,
      h,
      fn: () => {
        this.core.selectedBuilding = null;
        this.core.render();
      },
    });
  }

  // ── Train-troops modal (its own home-desk tile, sibling to drillYard) ────────
  // Split into ./trainModal.ts (form ① free function) purely to keep this file under the 500-line
  // convention — it has no life of its own outside this dispatch, so it takes `core` explicitly.
  renderTrainModal(): void {
    renderTrainModalImpl(this.core);
  }

  // ── Building bonus description lines ─────────────────────────────────────

  buildingBonusLines(
    key: BuildingKey,
    bld: Partial<Record<BuildingKey, number>> | undefined
  ): string[] {
    const lvl = buildingLevel(bld, key);
    const lines: string[] = [];
    switch (key) {
      case 'desk':
        lines.push(t('city.bonusGateMaster'));
        break;
      case 'inkPot':
        lines.push(
          t('city.bonusYield').replace(
            '{pct}',
            String(Math.round(buildingYieldMult(bld, 'ink') * 100))
          )
        );
        break;
      case 'paperTray':
        lines.push(
          t('city.bonusYield').replace(
            '{pct}',
            String(Math.round(buildingYieldMult(bld, 'paper') * 100))
          )
        );
        break;
      case 'graphiteMill':
        lines.push(
          t('city.bonusYield').replace(
            '{pct}',
            String(Math.round(buildingYieldMult(bld, 'graphite') * 100))
          )
        );
        break;
      case 'metalForge':
        lines.push(
          t('city.bonusYield').replace(
            '{pct}',
            String(Math.round(buildingYieldMult(bld, 'metal') * 100))
          )
        );
        break;
      case 'stickerShop': {
        const s = buildingSelfYield(bld, 'sticker');
        lines.push(t('city.bonusSelf').replace('{n}', this.core.fmtNum(s)));
        break;
      }
      case 'cabinet': {
        const capPct = Math.round((1 + lvl * CABINET_CAP_STEP) * 100);
        lines.push(t('city.bonusCap').replace('{pct}', String(capPct)));
        break;
      }
      case 'drillYard':
        lines.push(t('city.bonusTroopCap').replace('{n}', String(lvl * DRILL_TROOPCAP_STEP)));
        lines.push(
          t('city.bonusTrainSpeed').replace(
            '{pct}',
            String(Math.round(lvl * DRILL_TRAIN_SPEED_STEP * 100))
          )
        );
        lines.push(t('city.bonusQueueSlots').replace('{n}', String(trainQueueMaxFor(bld))));
        break;
      case 'wall': {
        // D-CITY-8: wall no longer buffs battle-time garrison HP — it caps the base's persistent, self-healing durability instead.
        lines.push(t('city.bonusWallHp').replace('{n}', String(baseDurabilityMax(lvl))));
        break;
      }
      case 'academy': {
        const hpPct = Math.round(lvl * ACADEMY_HP_STEP * 100);
        const dmgPct = Math.round(lvl * ACADEMY_DAMAGE_STEP * 100);
        if (hpPct > 0) lines.push(t('city.bonusAcademyHp').replace('{pct}', String(hpPct)));
        if (dmgPct > 0) lines.push(t('city.bonusAcademyDmg').replace('{pct}', String(dmgPct)));
        break;
      }
      case 'satchel':
        lines.push(t('city.bonusSatchel').replace('{n}', String(satchelCarryCapFor(bld))));
        break;
    }
    return lines;
  }
}
