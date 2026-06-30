import { ATTACK_LANES } from '@game/config';
import { TICK_RATE } from '@game/math/fixed';
import type { WaveEntry } from '@game/campaign/LevelDefinition';
import type { EditorState } from '../state/EditorState';
import { unitMeta } from '../units';

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
 */

const GUTTER_W = 56;
const RULER_H = 22;
const LANE_H = 30;
const SNAP_TICKS = 3; // 0.1s
const MIN_PPS = 12;
const MAX_PPS = 400;

const C = {
  bg: '#11111b',
  gutter: '#242436',
  ruler: '#242436',
  laneA: '#1c1c2c',
  laneB: '#191926',
  grid: '#2e2e46',
  gridSec: '#3a3a58',
  text: '#cdd6f4',
  dim: '#6e6e8a',
  sel: '#f5e0dc',
  boss: '#f9e2af',
};

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
    const h = RULER_H + this.laneCount * LANE_H;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.height = `${h}px`;
    this.render();
  }

  // ── coordinate transforms ──
  private tickToX(tick: number): number {
    return GUTTER_W + (tick / TICK_RATE) * this.pxPerSec - this.scrollX;
  }
  private xToTick(x: number): number {
    return ((x - GUTTER_W + this.scrollX) / this.pxPerSec) * TICK_RATE;
  }
  private laneIndex(col: number): number {
    return (ATTACK_LANES as readonly number[]).indexOf(col);
  }
  private yToLaneIndex(y: number): number {
    return Math.floor((y - RULER_H) / LANE_H);
  }
  private entryEndTick(e: WaveEntry): number {
    return e.atTick + Math.max(0, e.count - 1) * (e.spacingTicks ?? 0);
  }

  // ── hit test (reverse order so the topmost/last block wins) ──
  private hitTest(x: number, y: number): number | null {
    const li = this.yToLaneIndex(y);
    if (li < 0 || li >= this.laneCount) return null;
    const lane = (ATTACK_LANES as readonly number[])[li]!;
    const entries = this.state.waves;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.col !== lane) continue;
      const x0 = this.tickToX(e.atTick);
      const x1 = Math.max(x0 + 18, this.tickToX(this.entryEndTick(e)) + 18);
      if (x >= x0 - 4 && x <= x1) return i;
    }
    return null;
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
    const deltaTicks = this.xToTick(x) - this.drag.startMouseTick;
    let atTick = Math.round((this.drag.origAtTick + deltaTicks) / SNAP_TICKS) * SNAP_TICKS;
    if (atTick < 0) atTick = 0;

    // Vertical → col (snap to the lane row under the cursor).
    const li = this.yToLaneIndex(y);
    const patch: Partial<WaveEntry> = { atTick };
    if (li >= 0 && li < this.laneCount) {
      patch.col = (ATTACK_LANES as readonly number[])[li]!;
    }
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
      // Zoom around the cursor.
      const { x } = this.localXY(e);
      const tickAtCursor = this.xToTick(x);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.pxPerSec = Math.min(MAX_PPS, Math.max(MIN_PPS, this.pxPerSec * factor));
      // keep the tick under the cursor stationary
      this.scrollX = GUTTER_W + (tickAtCursor / TICK_RATE) * this.pxPerSec - x;
    } else {
      this.scrollX += e.deltaY + e.deltaX;
    }
    if (this.scrollX < 0) this.scrollX = 0;
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
    // choose a tick step that stays readable at the current zoom
    const stepSec = this.pxPerSec >= 120 ? 1 : this.pxPerSec >= 50 ? 2 : 5;
    const startSec = Math.floor(this.xToTick(GUTTER_W) / TICK_RATE);
    const endSec = Math.ceil(this.xToTick(w) / TICK_RATE);
    for (let sec = Math.max(0, startSec); sec <= endSec; sec++) {
      if (sec % stepSec !== 0) continue;
      const x = this.tickToX(sec * TICK_RATE);
      if (x < GUTTER_W) continue;
      ctx.strokeStyle = sec % (stepSec * 5) === 0 ? C.gridSec : C.grid;
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
      const li = this.laneIndex(e.col);
      if (li < 0) continue;
      const selected = this.state.selectedWave === i;
      const meta = unitMeta(e.unitType);
      const yTop = RULER_H + li * LANE_H + 4;
      const bh = LANE_H - 8;
      const x0 = this.tickToX(e.atTick);
      const x1 = this.tickToX(this.entryEndTick(e));
      const bw = Math.max(18, x1 - x0 + 18);

      // skip if fully off-screen to the left/right
      if (x0 + bw < GUTTER_W || x0 > this.canvas.width) continue;

      ctx.globalAlpha = selected ? 1 : 0.82;
      this.roundRect(x0, yTop, bw, bh, 4);
      ctx.fillStyle = meta.color;
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = C.sel;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // per-unit spacing ticks
      if (e.count > 1 && (e.spacingTicks ?? 0) > 0) {
        ctx.strokeStyle = 'rgba(17,17,27,0.5)';
        ctx.lineWidth = 1;
        for (let k = 1; k < e.count; k++) {
          const tx = this.tickToX(e.atTick + k * (e.spacingTicks ?? 0));
          ctx.beginPath();
          ctx.moveTo(tx + 0.5, yTop);
          ctx.lineTo(tx + 0.5, yTop + bh);
          ctx.stroke();
        }
      }

      ctx.fillStyle = '#11111b';
      const label = `${meta.label || meta.type}×${e.count}${e.isBoss ? ' ★' : ''}`;
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

    const stepSec = this.pxPerSec >= 120 ? 1 : this.pxPerSec >= 50 ? 2 : 5;
    const startSec = Math.floor(this.xToTick(GUTTER_W) / TICK_RATE);
    const endSec = Math.ceil(this.xToTick(w) / TICK_RATE);
    ctx.fillStyle = C.dim;
    ctx.font = '10px monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let sec = Math.max(0, startSec); sec <= endSec; sec++) {
      if (sec % stepSec !== 0) continue;
      const x = this.tickToX(sec * TICK_RATE);
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
