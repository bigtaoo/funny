// Train-troops modal (its own home-desk tile, sibling to drillYard) — split out of modals.ts
// (2026-08-11, form ① independent function module per claudedocs/client-modules.md's split-form
// priority note) purely to keep modals.ts under the 500-line convention; only ever called from
// ModalsPanel.renderTrainModal and has no life of its own outside it.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, scaledTxt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { formatDuration, dhmsFromMs } from '../worldmap/logic/formatDuration';
import { serverNow } from '../../net/serverClock';
import { buildIcon } from '../../render/icons';
import {
  troopTrainCost,
  TROOP_TRAIN_BATCH_MAX,
  TROOP_SPEEDUP_SECS_PER_COIN,
  troopCapFor,
  trainQueueMaxFor,
  RESOURCE_TYPES,
  type ResourceType,
} from '@nw/shared';
import type { CitySceneCore } from './core';

/**
 * Standalone training modal: troop-pool cap line + training-queue countdown + +100/+500/Max presets
 * + speedup. Feeds the unified base troop pool (`me.troops`, capped at troopCapFor(buildings)); the
 * trained troops are then distributed to team cards in the DefenseEditor. drillYard the building only
 * raises troopCap / training speed / queue slots — it no longer hosts these controls.
 */
export function renderTrainModal(core: CitySceneCore): void {
  const { w, h } = core;
  const bld = core.me?.buildings;
  const resources = core.me?.resources as Partial<Record<ResourceType, number>> | undefined;
  const trainQueue = core.me?.trainingQueue ?? [];
  const now = serverNow();
  // S8-8 fix (2026-08-08): the shop's `slg_speedup_*` items now start a persistent 2x-speed buff
  // (see server/worldsvc ShopService.buySlgShopItem) instead of one-time-draining the queue at
  // purchase time — surface that here so a player who bought it can see it's actually working.
  const speedupActive = (core.me?.speedupUntil ?? 0) > now;

  const mw = Math.min(340, w - 24);
  const contentH =
    12 +
    28 +
    (speedupActive ? 18 : 0) +
    20 +
    trainQueue.length * 16 +
    4 +
    36 +
    (trainQueue.length > 0 ? 34 : 0) +
    12;
  const mh = Math.min(contentH, h - 16);
  const scale = core.modalScaleFor(mw, mh);
  const screenW = mw * scale;
  const screenH = mh * scale;
  const screenX = (w - screenW) / 2;
  const screenY = Math.max(8, (h - screenH) / 2);

  const dim = new PIXI.Graphics();
  dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
  core.container.addChild(dim);

  const panelRoot = new PIXI.Container();
  panelRoot.position.set(screenX, screenY);
  panelRoot.scale.set(scale);
  core.container.addChild(panelRoot);
  const st = scaledTxt(scale);

  const panel = sketchPanel(mw, mh, {
    fill: C.paper,
    border: C.accent,
    width: 2,
    seed: seedFor(0, 5, mw),
  });
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

  if (speedupActive) {
    // 天/时/分/秒 breakdown (2026-08-08 UI fix) — matches the world-map HUD's buff chip.
    const remainMs = Math.max(0, (core.me?.speedupUntil ?? 0) - now);
    const buffLbl = st(t('world.speedup', dhmsFromMs(remainMs)), FS.tiny, C.accent, true);
    buffLbl.x = 10;
    buffLbl.y = iy;
    panelRoot.addChild(buffLbl);
    iy += 18;
  }

  const tc = troopCapFor(bld);
  const ts = core.me?.troops ?? 0;
  const troopLbl = st(
    t('city.troopCap').replace('{cur}', String(ts)).replace('{cap}', String(tc)),
    FS.tiny,
    C.mid
  );
  troopLbl.x = 10;
  troopLbl.y = iy;
  panelRoot.addChild(troopLbl);
  iy += 20;

  const queuedQty = trainQueue.reduce((s, e) => s + e.qty, 0);
  const queueMax = trainQueueMaxFor(bld);
  const queueFull = trainQueue.length >= queueMax;
  const capLeft = Math.max(0, tc - ts - queuedQty);
  const costPerTroop = troopTrainCost(1);

  // Slots-used / in-training / trainable, on one line under the pool line (2026-08-25). Without it the panel
  // showed only `troops/cap` and the preset buttons, so a greyed-out "Max +0" was unreadable: the headroom the
  // pool line implies is usually already spoken for by the queue (`capLeft` subtracts queuedQty), and nothing
  // told the player whether they were blocked by slots or by the cap — the two have different toasts and
  // different fixes (wait vs. upgrade drillYard).
  const queueLbl = st(
    t('city.trainQueueStatus')
      .replace('{n}', String(trainQueue.length))
      .replace('{max}', String(queueMax))
      .replace('{training}', String(queuedQty))
      .replace('{left}', String(capLeft)),
    FS.tiny,
    queueFull || capLeft <= 0 ? C.red : C.mid
  );
  queueLbl.x = 10;
  queueLbl.y = iy;
  panelRoot.addChild(queueLbl);
  iy += 20;
  // ADR-079: the slots run in parallel, so the array's enqueue order is no longer completion order — a
  // small batch queued last can be the first to land. Sort a copy for display so the countdowns read
  // top-to-bottom (`trainQueue` itself is the server's array and must not be reordered in place).
  const byCompletion = [...trainQueue].sort((a2, b2) => a2.completeAt - b2.completeAt);
  for (const e of byCompletion) {
    const sec = Math.max(0, Math.ceil((e.completeAt - now) / 1000));
    const ql = st(
      t('city.trainEntry').replace('{n}', String(e.qty)).replace('{time}', formatDuration(sec)),
      FS.tiny,
      C.dark
    );
    ql.x = 10;
    ql.y = iy;
    panelRoot.addChild(ql);
    iy += 16;
  }

  // Max affordable qty is bounded by every resource troop training spends (ink/paper/graphite/metal/sticker), not ink alone.
  const affordableByRes = RESOURCE_TYPES.map((rt) => {
    const per = costPerTroop[rt] ?? 0;
    return per > 0 ? Math.floor((resources?.[rt] ?? 0) / per) : Infinity;
  });
  const maxQty = Math.max(0, Math.min(TROOP_TRAIN_BATCH_MAX, capLeft, ...affordableByRes));
  const presets: Array<{ label: string; qty: number }> = [
    { label: '+100', qty: 100 },
    { label: '+500', qty: 500 },
    { label: t('city.trainMax').replace('{n}', String(maxQty)), qty: maxQty },
  ];
  const btnGap = 6;
  const btnW = (mw - 20 - btnGap * 2) / 3;
  let bx = 10;
  for (const p of presets) {
    const cost = troopTrainCost(p.qty);
    const canAffordCost = RESOURCE_TYPES.every((rt) => (resources?.[rt] ?? 0) >= (cost[rt] ?? 0));
    const ok = !queueFull && p.qty > 0 && p.qty <= capLeft && canAffordCost;
    const rectLocal = { x: bx, y: iy, w: btnW, h: 30 };
    const g = sketchPanel(rectLocal.w, rectLocal.h, {
      fill: ok ? C.paper : C.btnDis,
      border: C.line,
      width: 1,
      seed: seedFor(rectLocal.x, rectLocal.y, rectLocal.w),
    });
    g.x = rectLocal.x;
    g.y = rectLocal.y;
    panelRoot.addChild(g);
    const lbl = st(p.label, FS.tiny, ok ? C.dark : C.mid, true);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = rectLocal.x + rectLocal.w / 2;
    lbl.y = rectLocal.y + rectLocal.h / 2;
    panelRoot.addChild(lbl);
    const screenRect = core.toScreen(rectLocal, screenX, screenY, scale);
    core.hits.push({
      rect: screenRect,
      fn: () => {
        if (ok) {
          void core.doTrain(p.qty);
          return;
        }
        core.showToast(
          queueFull
            ? t('city.err.trainQueueFull')
            : capLeft <= 0 || p.qty > capLeft
            ? t('city.err.troopCap')
            : t('city.err.noResources'),
          C.red
        );
      },
    });
    bx += btnW + btnGap;
  }
  iy += 36;

  if (trainQueue.length > 0) {
    // Price = the SUM of every slot's remaining time, not the latest completeAt. speedupTraining burns
    // the purchased seconds off one slot at a time (earliest-finishing first, spilling into the next), so
    // the sum is exactly what it takes to drain the whole queue — the invariant "the advertised price
    // finishes everything" is the same one the chained queue had, it just stopped being `max` when
    // ADR-079 unchained the slots. Quoting `max` here would have under-charged and left slots running.
    const remainSec = byCompletion.reduce((s2, e) => s2 + Math.max(0, Math.ceil((e.completeAt - now) / 1000)), 0);
    const coins = Math.max(1, Math.ceil(remainSec / TROOP_SPEEDUP_SECS_PER_COIN));
    const rectLocal = { x: 10, y: iy, w: mw - 20, h: 30 };
    const g = sketchPanel(rectLocal.w, rectLocal.h, {
      fill: C.paper,
      border: C.accent,
      width: 1,
      seed: seedFor(rectLocal.x, rectLocal.y, rectLocal.w),
    });
    g.x = rectLocal.x;
    g.y = rectLocal.y;
    panelRoot.addChild(g);
    const lbl = st(t('city.speedup').replace('{coins}', String(coins)), FS.tiny, C.dark, true);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = rectLocal.x + rectLocal.w / 2;
    lbl.y = rectLocal.y + rectLocal.h / 2;
    panelRoot.addChild(lbl);
    const screenRect = core.toScreen(rectLocal, screenX, screenY, scale);
    core.hits.push({ rect: screenRect, fn: () => void core.doSpeedupTraining(coins) });
  }

  // Close on tap-outside — pushed LAST so panel buttons above take priority.
  core.hits.push({
    rect: { x: 0, y: 0, w, h },
    fn: () => {
      core.selectedTrain = false;
      core.render();
    },
  });
}
