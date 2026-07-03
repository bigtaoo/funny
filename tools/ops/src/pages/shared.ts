// Shared plumbing for the ops admin page renderers (OPS_DESIGN §7). Pure DOM.
// The per-page modules under pages/ each render into ctx.root; pages.ts re-exports
// them as a flat barrel so app.ts imports stay stable.
import type { Api } from '../api';
import { ApiError } from '../api';
import { h } from '../dom';
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

/** Inline SVG sparkline (shared by the live monitor + analytics DAU trend). */
export function sparkline(values: number[]): HTMLElement {
  if (values.length === 0) return h('div', { class: 'muted' }, 'No data');
  const w = 600;
  const ht = 80;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(ht - (v / max) * (ht - 6) - 3).toFixed(1)}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${ht}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(ht));
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute('points', pts);
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', '#2f5fcf');
  poly.setAttribute('stroke-width', '2');
  svg.append(poly);
  return svg as unknown as HTMLElement;
}

// ms ↔ datetime-local ("YYYY-MM-DDTHH:mm", local timezone). Shared by events + gacha pools.
export function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function localInputToMs(v: string): number {
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}
