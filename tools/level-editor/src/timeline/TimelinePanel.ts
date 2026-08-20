import { ATTACK_LANES } from '@nw/engine/config';
import { TICK_RATE } from '@nw/engine/math/fixed';
import type { WaveEntry } from '@nw/engine/campaign/LevelDefinition';
import type { EditorState } from '../state/EditorState';
import { unitMeta } from '../units';
import {
  C,
  GUTTER_W,
  LANE_H,
  RULER_H,
  blockLabel,
  blockRect,
  canvasHeight,
  gridStepSec,
  hitTest,
  isBlockVisible,
  isMajorSecond,
  laneColAt,
  laneIndex,
  panBy,
  snapAtTick,
  tickToX,
  unitTickXs,
  visibleSecondRange,
  xToTick,
  zoomAround,
} from '../layout/timeline';

/**
 * Wave timeline panel (P-D) — the core authoring surface.
 *
 * Horizontal axis = time (seconds); vertical axis = attack lanes (one row per
 * ATTACK_LANE, top-to-bottom in declaration order). Each {@link WaveEntry} is a
 * block spanning [atTick, atTick + (count-1)·spacingTicks] on its lane row,
 * labelled with the unit type and count. A single viewport canvas owns its own
 * pan (`scrollX`) and zoom (`pxPerSec`) so lane labels + ruler stay pinned.
 *
 * Interaction:
 *  - click a block to select (drives the inspector); drag horizontally to move
 *    `atTick` (snapped to 0.1s); drag across lane rows to change `col`.
 *  - right-click a block deletes it.
 *  - wheel pans; Ctrl/⌘+wheel zooms around the cursor; click empty deselects.
 *
 * NOTE (open question in DESIGN.md §9): rows are attack lanes here. Overlapping
 * blocks on one lane are drawn translucent rather than sub-row-packed — this is
 * deliberately honest about how busy a lane gets, to judge lanes-vs-groups.
 *
 * This class is the DOM/canvas half only: it owns the `<canvas>` and the
 * listeners, and delegates every tick↔pixel transform, block rectangle, hit
 * test, drag snap and pan/zoom decision to the pure `../layout/timeline` module
 * (ADR-070 Phase 4b) — which is where the tests live.
 */

interface Drag {
  index: number;
  startMouseTick: number;
  origAtTick: number;
}

export class TimelinePanel {
  readonly canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private pxPerSec = 70;
  private scrollX = 0; // px
  private drag: Drag | null = null;
  private ro: ResizeObserver;

  constructor(private state: EditorState, private mount: HTMLElement) {
    this.canvas.style.display = 'block';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    this.ctx = ctx;
    mount.appendChild(this.canvas);

    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', () => (this.drag = null));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => this.onContext(e));

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(mount);
    state.on(() => this.render());
    this.resize();
  }

  private laneCount = ATTACK_LANES.length;

  private resize(): void {
    const w = Math.max(200, this.mount.clientWidth);
    const h = canvasHeight(this.laneCount);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.height = `${h}px`;
    this.render();
  }

  // ── thin `this`-bound wrappers over the pure layout module ──
  private xToTick(x: number): number {
    return xToTick(x, this.pxPerSec, this.scrollX);
  }
  /** X of a whole-second gridline/label at the current pan+zoom. */
  private secondX(sec: number): number {
    return tickToX(sec * TICK_RATE, this.pxPerSec, this.scrollX);
  }
  private hitTest(x: number, y: number): number | null {
    return hitTest(x, y, this.state.waves, this.laneCount, this.pxPerSec, this.scrollX);
  }

  private localXY(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const { x, y } = this.localXY(e);
    const hit = this.hitTest(x, y);
    this.state.selectWave(hit);
    if (hit !== null) {
      this.drag = { index: hit, startMouseTick: this.xToTick(x), origAtTick: this.state.waves[hit]!.atTick };
    }
  }

  private onMove(e: MouseEvent): void {
    if (!this.drag) return;
    const { x, y } = this.localXY(e);
    const entry = this.state.waves[this.drag.index];
    if (!entry) return;

    // Horizontal → atTick (snapped, clamped ≥ 0).
    const atTick = snapAtTick(this.drag.origAtTick, this.xToTick(x) - this.drag.startMouseTick);

    // Vertical → col (snap to the lane row under the cursor).
    const patch: Partial<WaveEntry> = { atTick };
    const col = laneColAt(y, this.laneCount);
    if (col !== null) patch.col = col;
    this.state.updateWave(this.drag.index, patch);
  }

  private onContext(e: MouseEvent): void {
    e.preventDefault();
    const { x, y } = this.localXY(e);
    const hit = this.hitTest(x, y);
    if (hit !== null) this.state.removeWave(hit);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Zoom around the cursor (keeps the tick under it stationary).
      const { x } = this.localXY(e);
      const z = zoomAround(this.pxPerSec, this.scrollX, x, e.deltaY);
      this.pxPerSec = z.pxPerSec;
      this.scrollX = z.scrollX;
    } else {
      this.scrollX = panBy(this.scrollX, e.deltaY, e.deltaX);
    }
    this.render();
  }

  render(): void {
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    this.drawLaneBands(w);
    this.drawTimeGrid(w, h);
    this.drawBlocks();
    this.drawGutter(h);
    this.drawRuler(w);
  }

  private drawLaneBands(w: number): void {
    const ctx = this.ctx;
    for (let i = 0; i < this.laneCount; i++) {
      ctx.fillStyle = i % 2 === 0 ? C.laneA : C.laneB;
      ctx.fillRect(GUTTER_W, RULER_H + i * LANE_H, w - GUTTER_W, LANE_H);
    }
  }

  private drawTimeGrid(w: number, h: number): void {
    const ctx = this.ctx;
    const stepSec = gridStepSec(this.pxPerSec);
    const { startSec, endSec } = visibleSecondRange(this.pxPerSec, this.scrollX, w);
    for (let sec = startSec; sec <= endSec; sec++) {
      if (sec % stepSec !== 0) continue;
      const x = this.secondX(sec);
      if (x < GUTTER_W) continue;
      ctx.strokeStyle = isMajorSecond(sec, stepSec) ? C.gridSec : C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }
  }

  private drawBlocks(): void {
    const ctx = this.ctx;
    const entries = this.state.waves;
    ctx.textBaseline = 'middle';
    ctx.font = '11px monospace';
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const li = laneIndex(e.col);
      if (li < 0) continue;
      const rect = blockRect(e, li, this.pxPerSec, this.scrollX);

      // skip if fully off-screen to the left/right
      if (!isBlockVisible(rect, this.canvas.width)) continue;

      const { x: x0, y: yTop, w: bw, h: bh } = rect;
      const selected = this.state.selectedWave === i;
      ctx.globalAlpha = selected ? 1 : 0.82;
      this.roundRect(x0, yTop, bw, bh, 4);
      ctx.fillStyle = unitMeta(e.unitType).color;
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = C.sel;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // per-unit spacing ticks
      const tickXs = unitTickXs(e, this.pxPerSec, this.scrollX);
      if (tickXs.length > 0) {
        ctx.strokeStyle = 'rgba(17,17,27,0.5)';
        ctx.lineWidth = 1;
        for (const tx of tickXs) {
          ctx.beginPath();
          ctx.moveTo(tx + 0.5, yTop);
          ctx.lineTo(tx + 0.5, yTop + bh);
          ctx.stroke();
        }
      }

      ctx.fillStyle = '#11111b';
      const label = blockLabel(e);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, yTop, bw, bh);
      ctx.clip();
      ctx.fillText(label, x0 + 5, yTop + bh / 2);
      ctx.restore();
    }
  }

  private drawGutter(h: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = C.gutter;
    ctx.fillRect(0, 0, GUTTER_W, h);
    ctx.strokeStyle = C.gridSec;
    ctx.beginPath();
    ctx.moveTo(GUTTER_W + 0.5, 0);
    ctx.lineTo(GUTTER_W + 0.5, h);
    ctx.stroke();

    ctx.fillStyle = C.dim;
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < this.laneCount; i++) {
      const lane = (ATTACK_LANES as readonly number[])[i]!;
      ctx.fillStyle = C.text;
      ctx.fillText(`Col ${lane}`, GUTTER_W / 2, RULER_H + i * LANE_H + LANE_H / 2);
    }
    ctx.textAlign = 'left';
  }

  private drawRuler(w: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = C.gridSec;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(w, RULER_H + 0.5);
    ctx.stroke();

    const stepSec = gridStepSec(this.pxPerSec);
    const { startSec, endSec } = visibleSecondRange(this.pxPerSec, this.scrollX, w);
    ctx.fillStyle = C.dim;
    ctx.font = '10px monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let sec = startSec; sec <= endSec; sec++) {
      if (sec % stepSec !== 0) continue;
      const x = this.secondX(sec);
      if (x < GUTTER_W) continue;
      ctx.fillText(`${sec}s`, x + 3, RULER_H / 2);
    }
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
