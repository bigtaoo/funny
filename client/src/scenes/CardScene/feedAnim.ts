// In-engine fusion animation, split out of feed.ts (2026-08-11, form ① independent function module
// per claudedocs/client-modules.md's split-form priority note) purely to keep feed.ts under the
// 500-line convention: unlike the rest of feed.ts's openFuseSelect flow, this doesn't close over any
// per-panel-open local state (slotIds/artHooked/currentTarget/…) — it only needs the shared Core
// (for modalLayer/w/h) plus the ring geometry snapshot captured by the last drawFusePanel() pass, so
// it's a genuinely pure function rather than a domain class.
import * as PIXI from 'pixi.js-legacy';
import { ui as C } from '../../render/sketchUi';
import { getArtTexture } from '../../render/cardArt';
import type { CardSceneCore } from './core';

/** Screen-space geometry of the last-drawn ring, captured so playFusionAnimImpl can animate the 5
 * material portraits converging on the target before the burst plays. Carries each slot's/the
 * target's art URL + the ring's own radii so the animation can fly the *actual* portraits inward
 * instead of anonymous dots (2026-08-01: "everyone giving their power" reads a lot stronger when
 * you can see whose power it is). */
export interface FuseRingGeom {
  center: { x: number; y: number };
  slots: { x: number; y: number }[];
  color: number;
  centerR: number;
  slotR: number;
  slotArtUrl: (string | null)[];
  targetArtUrl: string | null;
}

/** In-engine fusion animation: the 5 material portraits swoop into the target one after another
 * (each on a bowed path with a fading ink trail, so the motion reads as "energy flow" rather than
 * "shape sliding"), each arrival ripples the target, then the target itself punches outward in a
 * gold burst. Program-art stand-in — a dedicated VFX-editor asset replaces this call site once
 * authored (feed.ts owns the whole visual, so the swap is local); this version reuses the cards'
 * own portrait textures + plain Graphics strokes (no new art, no extra texture uploads or additive
 * blending) to stay cheap on low-end/WeChat devices (2026-08-01). */
export async function playFusionAnimImpl(core: CardSceneCore, geom: FuseRingGeom | null): Promise<void> {
  const ml = core.modalLayer;
  const { w, h } = core;
  const cx = geom?.center.x ?? w / 2;
  const cy = geom?.center.y ?? h / 2;
  const color = geom?.color ?? C.gold;
  const centerR = geom?.centerR ?? 24;
  const slotR = geom?.slotR ?? 15;

  // Phase 1: the 5 material portraits swoop into the target, staggered so they read as distinct
  // contributions instead of one synchronized slide; each arrival ripples the target.
  if (geom && geom.slots.length > 0) {
    const STAGGER_MS = 60;
    const FLIGHT_MS = 360;
    const RIPPLE_MS = 240;
    const BOW = 30; // px the path bows sideways before straightening into the target

    const dots = geom.slots.map((s, i) => {
      const artUrl = geom.slotArtUrl[i];
      const tex = artUrl ? getArtTexture(artUrl) : null;
      let display: PIXI.Sprite | PIXI.Graphics;
      if (tex && tex.baseTexture.valid) {
        const sp = new PIXI.Sprite(tex);
        sp.anchor.set(0.5);
        sp.scale.set(Math.min((slotR * 2) / tex.width, (slotR * 2) / tex.height));
        display = sp;
      } else {
        const g = new PIXI.Graphics();
        g.beginFill(color).drawCircle(0, 0, slotR * 0.7).endFill();
        display = g;
      }
      display.position.set(s.x, s.y);
      display.visible = false; // hidden until its stagger delay elapses
      ml.addChild(display);
      const trail = new PIXI.Graphics();
      ml.addChild(trail);
      return {
        display, trail, from: s, delay: i * STAGGER_MS, history: [] as { x: number; y: number }[],
        bowSign: i % 2 === 0 ? 1 : -1, baseScaleX: display.scale.x, baseScaleY: display.scale.y, done: false,
      };
    });
    const ripples: { start: number; g: PIXI.Graphics }[] = [];

    await new Promise<void>((resolve) => {
      const start = performance.now();
      const cleanupAndResolve = (): void => {
        for (const d of dots) { if (!d.display.destroyed) d.display.destroy(); if (!d.trail.destroyed) d.trail.destroy(); }
        for (const r of ripples) if (!r.g.destroyed) r.g.destroy();
        resolve();
      };
      const tick = (): void => {
        // If anything tore down the modal layer (scene destroy, a texture-load redraw) mid-flight,
        // the still-live dots become destroyed graphics; touching them would throw. Bail cleanly.
        if (ml.destroyed || dots.some((d) => !d.done && d.display.destroyed)) { cleanupAndResolve(); return; }
        const now = performance.now();
        let allDone = true;
        for (const d of dots) {
          if (d.done) continue;
          const localT = now - start - d.delay;
          if (localT < 0) { allDone = false; continue; } // still waiting for its turn
          d.display.visible = true;
          const f = Math.min(1, localT / FLIGHT_MS);
          const e = 1 - (1 - f) * (1 - f); // ease-out
          const dx = cx - d.from.x, dy = cy - d.from.y;
          const len = Math.hypot(dx, dy) || 1;
          const bow = Math.sin(f * Math.PI) * BOW * d.bowSign; // bows out then straightens on arrival
          const x = d.from.x + dx * e + (-dy / len) * bow;
          const y = d.from.y + dy * e + (dx / len) * bow;
          d.display.position.set(x, y);
          d.display.scale.set(d.baseScaleX * (1 - 0.6 * e), d.baseScaleY * (1 - 0.6 * e));
          d.display.alpha = 1 - 0.3 * e;
          d.history.unshift({ x, y });
          if (d.history.length > 6) d.history.length = 6;
          d.trail.clear();
          for (let i = 0; i < d.history.length - 1; i++) {
            const a = d.history[i], b = d.history[i + 1];
            const t = i / d.history.length;
            d.trail.lineStyle(Math.max(1, slotR * 0.5 * (1 - t)), color, (1 - t) * 0.35);
            d.trail.moveTo(a.x, a.y).lineTo(b.x, b.y);
          }
          if (f >= 1) {
            d.done = true;
            d.display.destroy();
            d.trail.destroy();
            ripples.push({ start: now, g: ml.addChild(new PIXI.Graphics()) });
          } else {
            allDone = false;
          }
        }
        for (const r of ripples) {
          const rf = Math.min(1, (now - r.start) / RIPPLE_MS);
          if (rf < 1) allDone = false;
          r.g.clear();
          r.g.lineStyle(3, color, 1 - rf);
          r.g.drawCircle(cx, cy, centerR * 0.5 + rf * centerR * 0.9);
        }
        if (allDone) cleanupAndResolve(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // Phase 2: the target absorbs it all — screen flash, expanding ring + radiating spokes, and the
  // target portrait itself punches outward (squash/stretch) so the payoff reads as impact, not just
  // a shape pulsing in empty space. That shockwave is a symmetric sin pulse (0 → 1 → 0), so its own
  // last frame is exactly invisible — fine for a shockwave, but it left the animation with nothing
  // to land on. A separate gold "seal" halo fixes that: fixed geometry (drawn ONCE below, radius
  // never changes) that blooms in alongside the shockwave, holds at full strength for a beat once
  // the shockwave has faded, then eases out — every frame after the first is a single `alpha`
  // write, no clear+redraw, so the extra hold time is essentially free (2026-08-02).
  const flash = new PIXI.Graphics();
  flash.beginFill(0xffe28a, 0).drawRect(0, 0, w, h).endFill();
  ml.addChild(flash);
  const burst = new PIXI.Graphics();
  ml.addChild(burst);
  const haloR = centerR + 12;
  const halo = new PIXI.Graphics();
  halo.lineStyle(3, C.gold, 1).drawCircle(cx, cy, haloR);
  halo.beginFill(C.gold, 0.14).drawCircle(cx, cy, haloR).endFill();
  halo.alpha = 0;
  ml.addChild(halo);
  let targetOverlay: PIXI.Sprite | null = null;
  let targetBaseScale = 1;
  if (geom?.targetArtUrl) {
    const tex = getArtTexture(geom.targetArtUrl);
    if (tex.baseTexture.valid) {
      targetOverlay = new PIXI.Sprite(tex);
      targetOverlay.anchor.set(0.5);
      targetBaseScale = Math.min((centerR * 2) / tex.width, (centerR * 2) / tex.height);
      targetOverlay.scale.set(targetBaseScale);
      targetOverlay.position.set(cx, cy);
      ml.addChild(targetOverlay);
    }
  }
  const SPOKES = 8;
  const BURST_MS = 700;
  const HALO_PEAK_ALPHA = 0.8;
  const HALO_FADE_IN_MS = BURST_MS * 0.6; // blooms in while the shockwave is still visible
  const HALO_HOLD_MS = 220; // ...then holds solid for a beat once the shockwave's gone — the "landing" frame
  const HALO_FADE_OUT_MS = 260;
  const TOTAL_MS = BURST_MS + HALO_HOLD_MS + HALO_FADE_OUT_MS;
  let burstLive = true;
  await new Promise<void>((resolve) => {
    const start = performance.now();
    const tick = (): void => {
      // flash/burst are destroyed intentionally below once the shockwave finishes, well before
      // halo — so only halo (+ modal-layer teardown) indicates an external abort worth bailing on.
      if (ml.destroyed || halo.destroyed || (targetOverlay && targetOverlay.destroyed)) { resolve(); return; }
      const elapsed = performance.now() - start;

      if (burstLive) {
        const f = Math.min(1, elapsed / BURST_MS);
        const pulse = Math.sin(f * Math.PI); // 0 → 1 → 0
        flash.alpha = pulse * 0.5;
        burst.clear();
        burst.lineStyle(4, C.gold, pulse);
        burst.drawCircle(cx, cy, centerR + pulse * 70);
        burst.lineStyle(2, color, pulse * 0.8);
        for (let i = 0; i < SPOKES; i++) {
          const ang = (i * 2 * Math.PI) / SPOKES;
          const r0 = centerR + pulse * 18, r1 = centerR + pulse * 100;
          burst.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
          burst.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
        }
        if (targetOverlay) {
          const punch = Math.sin(Math.min(1, f * 1.6) * Math.PI) * 0.22 * (1 - f * 0.5);
          targetOverlay.scale.set(targetBaseScale * (1 + punch), targetBaseScale * (1 - punch * 0.6));
        }
        if (f >= 1) { burstLive = false; flash.destroy(); burst.destroy(); }
      }

      // Halo geometry was drawn once above; every frame here is just an alpha write.
      if (elapsed < HALO_FADE_IN_MS) {
        const e = elapsed / HALO_FADE_IN_MS;
        halo.alpha = HALO_PEAK_ALPHA * e * e; // ease-in
      } else if (elapsed < BURST_MS + HALO_HOLD_MS) {
        halo.alpha = HALO_PEAK_ALPHA;
      } else {
        const fadeF = Math.min(1, (elapsed - BURST_MS - HALO_HOLD_MS) / HALO_FADE_OUT_MS);
        halo.alpha = HALO_PEAK_ALPHA * (1 - fadeF);
      }

      if (elapsed >= TOTAL_MS) {
        if (!flash.destroyed) flash.destroy();
        if (!burst.destroyed) burst.destroy();
        halo.destroy();
        targetOverlay?.destroy();
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
}
