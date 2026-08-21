// Shared plumbing for the ops admin page renderers (OPS_DESIGN §7). Pure DOM.
// The per-page modules under pages/ each render into ctx.root; pages.ts re-exports
// them as a flat barrel so app.ts imports stay stable.
//
// ADR-070 Phase 4e (2026-08-20) moved the arithmetic that used to live here — the ms ↔
// datetime-local pair and the sparkline's point list — into src/logic/shared.ts, leaving this file
// as what its header always claimed it was: the DOM half. `sparkline` below is the shape that split
// takes everywhere in this console: geometry in logic/, element construction here.
import type { Api } from '../api';
import { ApiError } from '../api';
import { h } from '../dom';
import { SPARK_H, SPARK_W, sparklinePoints } from '../logic/shared';
import type { Session } from '../types';

export type Ctx = { api: Api; session: Session; root: HTMLElement; onTeardown: (fn: () => void) => void };

export function showErr(el: HTMLElement, e: unknown): void {
  const msg = e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message;
  el.textContent = msg;
  el.className = 'err';
}
export function showOk(el: HTMLElement, msg: string): void {
  el.textContent = msg;
  el.className = 'err ok';
}

/** `showErr` into a fresh node, for the callers that append an error instead of filling a slot. */
export function errNode(e: unknown): HTMLElement {
  const el = h('div', {});
  showErr(el, e);
  return el;
}

/** Inline SVG sparkline (shared by the live monitor + analytics DAU trend). */
export function sparkline(values: number[]): HTMLElement {
  if (values.length === 0) return h('div', { class: 'muted' }, 'No data');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(SPARK_H));
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute('points', sparklinePoints(values));
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', '#2f5fcf');
  poly.setAttribute('stroke-width', '2');
  svg.append(poly);
  return svg as unknown as HTMLElement;
}
