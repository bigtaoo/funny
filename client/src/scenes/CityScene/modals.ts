// Building detail modal + train-troops modal + building bonus-line descriptions.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, scaledTxt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { formatDuration } from '../worldmap/formatDuration';
import { buildIcon } from '../../render/icons';
import type { BuildingKey } from '../../net/WorldApiClient';
import {
  DESK_MAX_LEVEL,
  CABINET_CAP_STEP,
  DRILL_TROOPCAP_STEP,
  DRILL_TRAIN_SPEED_STEP,
  TROOP_TRAIN_INK_COST,
  TROOP_TRAIN_BATCH_MAX,
  TROOP_SPEEDUP_SECS_PER_COIN,
  baseDurabilityMax,
  ACADEMY_HP_STEP,
  ACADEMY_DAMAGE_STEP,
  SATCHEL_CARRY_STEP,
  buildingLevel,
  buildCost,
  buildTimeSec,
  buildGateReason,
  buildingYieldMult,
  buildingSelfYield,
  troopCapFor,
  trainQueueMaxFor,
  satchelCarryCapFor,
  RESOURCE_TYPES,
  type ResourceType,
} from '@nw/shared';
import { type Constructor, type CitySceneBaseCtor } from './base';

export interface ModalsHandlers {
  renderDetailModal(key: BuildingKey): void;
  renderTrainModal(): void;
  buildingBonusLines(key: BuildingKey, bld: Partial<Record<BuildingKey, number>> | undefined): string[];
}

export function ModalsMixin<TBase extends CitySceneBaseCtor>(Base: TBase): TBase & Constructor<ModalsHandlers> {
  return class extends Base {
    // ── Detail modal ──────────────────────────────────────────────────────────

    renderDetailModal(key: BuildingKey): void {
      const { w, h } = this;
      const bld = this.me?.buildings;
      const resources = this.me?.resources as Partial<Record<ResourceType, number>> | undefined;

      const lvl = buildingLevel(bld, key);
      const toLevel = lvl + 1;
      const gateReason = buildGateReason(bld, key, toLevel);
      const cost = buildCost(key, toLevel);
      const timeSec = buildTimeSec(key, toLevel);
      const inQueue = (this.me?.buildQueue ?? []).some(q => q.key === key);
      const canAfford = !gateReason && Object.entries(cost).every(
        ([rt, need]) => (resources?.[rt as ResourceType] ?? 0) >= (need ?? 0)
      );
      const atMax = lvl >= DESK_MAX_LEVEL && key === 'desk';

      // Natural (unscaled) content size — laid out in a local frame, then scaled to
      // fill 80% of the constrained screen axis (popup-scale-to-80% convention).
      const bonusLines = this.buildingBonusLines(key, bld);
      const mw = Math.min(340, w - 24);
      const costEntries = RESOURCE_TYPES.map((rt) => ({ rt, need: cost[rt] ?? 0 })).filter((e) => e.need > 0);
      const contentH = 12 + 28 + bonusLines.length * 16 + 4
        + (atMax ? 20 : (16 + (costEntries.length > 0 ? 16 : 0) + 24 + 36))
        + 12;
      const mh = Math.min(contentH, h - 16);

      const scale = this.modalScaleFor(mw, mh);
      const screenW = mw * scale;
      const screenH = mh * scale;
      const screenX = (w - screenW) / 2;
      const screenY = Math.max(8, (h - screenH) / 2);

      // Dim covers the full screen; tapping it (outside interactive rects) closes the modal.
      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
      this.container.addChild(dim);

      const panelRoot = new PIXI.Container();
      panelRoot.position.set(screenX, screenY);
      panelRoot.scale.set(scale);
      this.container.addChild(panelRoot);
      // Compensates PIXI.Text's raster blur from the panelRoot scale-up above — see scaledTxt().
      const st = scaledTxt(scale);

      const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.accent, width: 2, seed: seedFor(0, 5, mw) });
      panelRoot.addChild(panel);

      let iy = 12;

      // Header — building glyph + name + level.
      const hIcon = this.bldIcon(key, 22, C.dark);
      hIcon.x = 10;
      hIcon.y = iy - 2;
      panelRoot.addChild(hIcon);
      const hdrTxt = st(`${t(`city.bld.${key}` as 'city.bld.desk')} ${t('city.lvlLabel').replace('{lvl}', String(lvl))}`, FS.small, C.dark, true);
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
            const mi = this.resIcon(rt, 15);
            mi.x = cxp;
            mi.y = iy - 1;
            panelRoot.addChild(mi);
            cxp += 17;
            const nl = st(this.fmtNum(need), FS.tiny, ok ? C.dark : C.red);
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
        } else {
          const btnRectLocal = { x: 10, y: iy, w: mw - 20, h: 32 };
          const g = sketchPanel(btnRectLocal.w, btnRectLocal.h, {
            fill: canAfford ? C.paper : C.btnDis, border: C.line, width: 1, seed: seedFor(btnRectLocal.x, btnRectLocal.y, btnRectLocal.w),
          });
          g.x = btnRectLocal.x;
          g.y = btnRectLocal.y;
          panelRoot.addChild(g);
          const lbl = st(t('city.upgrade'), FS.tiny, canAfford ? C.dark : C.mid, true);
          lbl.x = btnRectLocal.x + 8;
          lbl.y = btnRectLocal.y + (btnRectLocal.h - 16) / 2;
          panelRoot.addChild(lbl);

          const screenRect = this.toScreen(btnRectLocal, screenX, screenY, scale);
          this.hits.push({
            x: screenRect.x, y: screenRect.y, w: screenRect.w, h: screenRect.h,
            fn: canAfford ? () => void this.doUpgrade(key) : () => this.showToast(t('city.err.noResources'), C.red),
          });
          iy += 36;
        }
      }

      // Close on tap-outside — pushed LAST so panel buttons above take priority.
      this.hits.push({ x: 0, y: 0, w, h, fn: () => { this.selectedBuilding = null; this.render(); } });
    }

    // ── Train-troops modal (its own home-desk tile, sibling to drillYard) ────────

    /**
     * Standalone training modal: troop-pool cap line + training-queue countdown + +100/+500/Max presets
     * + speedup. Feeds the unified base troop pool (`me.troops`, capped at troopCapFor(buildings)); the
     * trained troops are then distributed to team cards in the DefenseEditor. drillYard the building only
     * raises troopCap / training speed / queue slots — it no longer hosts these controls.
     */
    renderTrainModal(): void {
      const { w, h } = this;
      const bld = this.me?.buildings;
      const resources = this.me?.resources as Partial<Record<ResourceType, number>> | undefined;
      const trainQueue = this.me?.trainingQueue ?? [];

      const mw = Math.min(340, w - 24);
      const contentH = 12 + 28 + 20 + trainQueue.length * 16 + 4 + 36 + (trainQueue.length > 0 ? 34 : 0) + 12;
      const mh = Math.min(contentH, h - 16);
      const scale = this.modalScaleFor(mw, mh);
      const screenW = mw * scale;
      const screenH = mh * scale;
      const screenX = (w - screenW) / 2;
      const screenY = Math.max(8, (h - screenH) / 2);

      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
      this.container.addChild(dim);

      const panelRoot = new PIXI.Container();
      panelRoot.position.set(screenX, screenY);
      panelRoot.scale.set(scale);
      this.container.addChild(panelRoot);
      const st = scaledTxt(scale);

      const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.accent, width: 2, seed: seedFor(0, 5, mw) });
      panelRoot.addChild(panel);

      let iy = 12;

      // Header — troops glyph + "Train Troops".
      const hIcon = buildIcon('armor', 22, C.dark);
      hIcon.x = 10;
      hIcon.y = iy - 2;
      panelRoot.addChild(hIcon);
      const hdrTxt = st(t('city.bld.trainTroops'), FS.small, C.dark, true);
      hdrTxt.x = 38;
      hdrTxt.y = iy;
      panelRoot.addChild(hdrTxt);
      iy += 28;

      const tc = troopCapFor(bld);
      const ts = this.me?.troops ?? 0;
      const troopLbl = st(t('city.troopCap').replace('{cur}', String(ts)).replace('{cap}', String(tc)), FS.tiny, C.mid);
      troopLbl.x = 10;
      troopLbl.y = iy;
      panelRoot.addChild(troopLbl);
      iy += 20;

      const queuedQty = trainQueue.reduce((s, e) => s + e.qty, 0);
      const queueMax = trainQueueMaxFor(bld);
      const queueFull = trainQueue.length >= queueMax;
      const capLeft = Math.max(0, tc - ts - queuedQty);
      const ink = Math.floor(resources?.ink ?? 0);
      const now = Date.now();
      for (const e of trainQueue) {
        const sec = Math.max(0, Math.ceil((e.completeAt - now) / 1000));
        const ql = st(t('city.trainEntry').replace('{n}', String(e.qty)).replace('{time}', formatDuration(sec)), FS.tiny, C.dark);
        ql.x = 10;
        ql.y = iy;
        panelRoot.addChild(ql);
        iy += 16;
      }

      const maxQty = Math.max(0, Math.min(TROOP_TRAIN_BATCH_MAX, capLeft, Math.floor(ink / TROOP_TRAIN_INK_COST)));
      const presets: Array<{ label: string; qty: number }> = [
        { label: '+100', qty: 100 },
        { label: '+500', qty: 500 },
        { label: t('city.trainMax').replace('{n}', String(maxQty)), qty: maxQty },
      ];
      const btnGap = 6;
      const btnW = (mw - 20 - btnGap * 2) / 3;
      let bx = 10;
      for (const p of presets) {
        const ok = !queueFull && p.qty > 0 && p.qty <= capLeft && p.qty * TROOP_TRAIN_INK_COST <= ink;
        const rectLocal = { x: bx, y: iy, w: btnW, h: 30 };
        const g = sketchPanel(rectLocal.w, rectLocal.h, {
          fill: ok ? C.paper : C.btnDis, border: C.line, width: 1, seed: seedFor(rectLocal.x, rectLocal.y, rectLocal.w),
        });
        g.x = rectLocal.x;
        g.y = rectLocal.y;
        panelRoot.addChild(g);
        const lbl = st(p.label, FS.tiny, ok ? C.dark : C.mid, true);
        lbl.x = rectLocal.x + 6;
        lbl.y = rectLocal.y + (rectLocal.h - 16) / 2;
        panelRoot.addChild(lbl);
        const screenRect = this.toScreen(rectLocal, screenX, screenY, scale);
        this.hits.push({
          x: screenRect.x, y: screenRect.y, w: screenRect.w, h: screenRect.h,
          fn: () => {
            if (ok) { void this.doTrain(p.qty); return; }
            this.showToast(queueFull ? t('city.err.trainQueueFull') : (p.qty <= 0 || p.qty > capLeft ? t('city.err.troopCap') : t('city.err.noInk')), C.red);
          },
        });
        bx += btnW + btnGap;
      }
      iy += 36;

      if (trainQueue.length > 0) {
        const lastDone = trainQueue[trainQueue.length - 1]!.completeAt;
        const remainSec = Math.max(0, Math.ceil((lastDone - now) / 1000));
        const coins = Math.max(1, Math.ceil(remainSec / TROOP_SPEEDUP_SECS_PER_COIN));
        const rectLocal = { x: 10, y: iy, w: mw - 20, h: 30 };
        const g = sketchPanel(rectLocal.w, rectLocal.h, {
          fill: C.paper, border: C.accent, width: 1, seed: seedFor(rectLocal.x, rectLocal.y, rectLocal.w),
        });
        g.x = rectLocal.x;
        g.y = rectLocal.y;
        panelRoot.addChild(g);
        const lbl = st(t('city.speedup').replace('{coins}', String(coins)), FS.tiny, C.dark, true);
        lbl.x = rectLocal.x + 8;
        lbl.y = rectLocal.y + (rectLocal.h - 16) / 2;
        panelRoot.addChild(lbl);
        const screenRect = this.toScreen(rectLocal, screenX, screenY, scale);
        this.hits.push({
          x: screenRect.x, y: screenRect.y, w: screenRect.w, h: screenRect.h,
          fn: () => void this.doSpeedupTraining(coins),
        });
      }

      // Close on tap-outside — pushed LAST so panel buttons above take priority.
      this.hits.push({ x: 0, y: 0, w, h, fn: () => { this.selectedTrain = false; this.render(); } });
    }

    // ── Building bonus description lines ─────────────────────────────────────

    buildingBonusLines(key: BuildingKey, bld: Partial<Record<BuildingKey, number>> | undefined): string[] {
      const lvl = buildingLevel(bld, key);
      const lines: string[] = [];
      switch (key) {
        case 'desk':
          lines.push(t('city.bonusGateMaster'));
          break;
        case 'inkPot':
          lines.push(t('city.bonusYield').replace('{pct}', String(Math.round(buildingYieldMult(bld, 'ink') * 100))));
          break;
        case 'paperTray':
          lines.push(t('city.bonusYield').replace('{pct}', String(Math.round(buildingYieldMult(bld, 'paper') * 100))));
          break;
        case 'graphiteMill':
          lines.push(t('city.bonusYield').replace('{pct}', String(Math.round(buildingYieldMult(bld, 'graphite') * 100))));
          break;
        case 'metalForge':
          lines.push(t('city.bonusYield').replace('{pct}', String(Math.round(buildingYieldMult(bld, 'metal') * 100))));
          break;
        case 'stickerShop': {
          const s = buildingSelfYield(bld, 'sticker');
          lines.push(t('city.bonusSelf').replace('{n}', this.fmtNum(s)));
          break;
        }
        case 'cabinet': {
          const capPct = Math.round((1 + lvl * CABINET_CAP_STEP) * 100);
          lines.push(t('city.bonusCap').replace('{pct}', String(capPct)));
          break;
        }
        case 'drillYard':
          lines.push(t('city.bonusTroopCap').replace('{n}', String(lvl * DRILL_TROOPCAP_STEP)));
          lines.push(t('city.bonusTrainSpeed').replace('{pct}', String(Math.round(lvl * DRILL_TRAIN_SPEED_STEP * 100))));
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
  };
}
