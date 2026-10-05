/**
 * unitLab.ts — side-by-side bench for battle-unit animation, booted by `?unitlab` (entries/web.ts).
 *
 * For every unit type with a baked frame sheet (FRAME_ASSETS) it plays each clip twice: the bone
 * rig (.tao) on the left of the pair and the frame sheet on the right, at the unit's real battle
 * height and enlarged. The attack clip runs at a 1 s attack interval and death replays every few
 * seconds, so the clips can be judged without a backend or a match.
 * `?unitlab&zoom=4` changes the enlarged scale; `&flash` pulses the hit flash; `&skin=skin_shop_r1`
 * benches that skin's .tao against its sheet (SKIN_FRAME_ASSETS) instead of the default look.
 */
import * as PIXI from 'pixi.js-legacy';
import { UnitType } from '@nw/engine/types';
import { palette } from './theme';
import { STICKMAN_ASSETS, FRAME_ASSETS, resolveSkinOverrides, resolveSkinFrameOverrides } from './UnitView/assets';
import { StickmanRuntime } from './stickman/StickmanRuntime';
import { FrameRuntime } from './frames/FrameRuntime';
import { loadFrameSheet } from './frames/frameSheet';
import { targetScreenHeight } from './unitSize';
import type { UnitRuntime } from './unitRuntime';

const CLIPS = ['idle', 'walk', 'attack', 'death'] as const;
const STATE_FOR: Record<(typeof CLIPS)[number], string> = {
  idle: 'waiting', walk: 'moving', attack: 'attacking', death: 'dead',
};
const DEATH_REPLAY_SEC = 3;

export async function startUnitLab(canvas: HTMLCanvasElement): Promise<void> {
  const params = new URLSearchParams(window.location.search); // dom-ok: web-only dev bench, booted from entries/web.ts
  const zoom = Number(params.get('zoom') ?? 3);
  const flash = params.has('flash');
  const app = new PIXI.Application({
    width: window.innerWidth, height: window.innerHeight, backgroundColor: palette.paper, // dom-ok: web-only dev bench
    view: canvas, antialias: true, resolution: window.devicePixelRatio || 1, autoDensity: true, // dom-ok: web-only dev bench, booted from entries/web.ts
  });

  // `&unit=shieldbearer,max` limits the bench to those types, since it only fits about two per screen
  const only = params.get('unit')?.split(',');
  const skin = params.get('skin');
  const skinFrames = skin ? resolveSkinFrameOverrides([skin]) : {};
  const rigs = skin ? { ...STICKMAN_ASSETS, ...resolveSkinOverrides([skin]) } : STICKMAN_ASSETS;
  const frames = skin ? skinFrames : FRAME_ASSETS;
  const types = (Object.keys(frames) as UnitType[]).filter((t) => !only || only.includes(t));
  const figures: Array<{ runtime: UnitRuntime; clip: (typeof CLIPS)[number] }> = [];
  const colW = 120 * zoom / 3 + 40;
  let y = 30;
  for (const type of types) {
    const h = targetScreenHeight(type);
    const { png, json } = frames[type]!;
    const [asset, sheet] = await Promise.all([
      StickmanRuntime.loadAsset(rigs[type]!, h), loadFrameSheet(png, json),
    ]);
    const label = new PIXI.Text(`${skin ? `${skin} ` : ''}${type} — left: bone rig, right: frame sheet`, { fontSize: 14, fill: 0x333333 });
    label.position.set(10, y);
    app.stage.addChild(label);
    y += 24;
    for (const scale of [1, zoom]) {
      const rowH = h * scale * 1.25;
      CLIPS.forEach((clip, i) => {
        const x0 = 40 + i * (colW * 2 + 30) * (scale === 1 ? 0.45 : 1);
        const pair: UnitRuntime[] = [
          new StickmanRuntime(asset, { targetHeight: h * scale }),
          new FrameRuntime(sheet, { targetHeight: h * scale }),
        ];
        pair.forEach((runtime, j) => {
          runtime.container.position.set(x0 + j * (scale === 1 ? colW * 0.45 : colW), y + rowH * 0.62);
          runtime.setAttackInterval(1);
          runtime.syncState(STATE_FOR[clip]);
          app.stage.addChild(runtime.container);
          figures.push({ runtime, clip });
        });
        if (scale !== 1) {
          const t = new PIXI.Text(clip, { fontSize: 13, fill: 0x666666 });
          t.position.set(x0, y);
          app.stage.addChild(t);
        }
      });
      y += rowH + 10;
    }
    y += 20;
  }

  // Handle for measuring the pair from the console (bounds, shadow ground) while tuning a sheet.
  (globalThis as { __unitLab?: unknown }).__unitLab = { app, figures };

  let deathClock = 0;
  let flashClock = 0;
  app.ticker.add(() => {
    const dt = app.ticker.deltaMS / 1000;
    deathClock += dt;
    flashClock += dt;
    const replayDeath = deathClock > DEATH_REPLAY_SEC;
    if (replayDeath) deathClock = 0;
    for (const { runtime, clip } of figures) {
      if (clip === 'death' && replayDeath) { runtime.play('idle'); runtime.play('death'); }
      if (clip !== 'death') runtime.syncState(STATE_FOR[clip]);
      runtime.update(dt);
      if (flash) runtime.setOutlineFlash(flashClock % 1 < 0.12 ? 0xff5a2b : null, 0.7);
    }
  });
}
