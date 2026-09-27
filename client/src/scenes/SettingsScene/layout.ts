// SettingsScene's flow layout (UI_DESIGN_LOG_2026-09 §65).
//
// The screen used to pin every section to a hand-tuned fraction of `h` and keep them apart with
// comments ("this band fits exactly one row"). Adding anything meant re-deriving every neighbour, and
// the language row running full width is what forced the volume block, the two toggles and the legal
// links into the odd corners they ended up in. This module replaces that with a y-cursor:
//
//   * a `Page` owns the scrolled content layer and turns content-space rects into on-screen hit /
//     slider rects (shifted by the scroll offset, clipped to the viewport, dropped when off-screen);
//   * a `Column` is an x-range plus a cursor; landscape gets two, portrait one;
//   * `section()` draws a small heading and a card whose height is known only after its rows are
//     laid out, so the card is inserted BEHIND the rows once they are done;
//   * every row is "label (+ wrapped hint) on the left, control flush with the card's right edge".
//
// Sections only say which rows they have. Nothing here knows about any particular setting.
import * as PIXI from 'pixi.js-legacy';
import { ui as C, sketchPanel, txt } from '../../render/sketchUi';
import { monospaceWidth } from '../../render/pixiText';
import { FS, snapFont } from '../../render/fontScale';
import { buildIcon, type IconKind } from '../../render/icons';
import { drawButtonLabel, buttonLabelIconW } from '../../ui/widgets/buttonLabel';
import type { Rect } from '../../layout/ILayout';
import type { Hit } from '../../ui/hits';
import type { AudioCue } from '../../audio/types';
import type { AudioSlider } from './audioPanel';

/** Spacing in design px, scaled by the short side (1080 in both orientations at the reference size). */
export interface PageMetrics {
  /** Card inner padding. */
  pad: number;
  /** Vertical padding inside a row. */
  rowPadY: number;
  rowMinH: number;
  /** Height of a toggle / segment / small button. */
  ctrlH: number;
  toggleW: number;
  /** Horizontal gap between a row's text block and its control, and between columns' contents. */
  gap: number;
  /** Air between one section's card and the next section's heading. */
  sectionGap: number;
  /** Air between a section heading and its card. */
  titleGap: number;
  /** Gap between the two landscape columns. */
  colGap: number;
}

export function pageMetrics(w: number, h: number): PageMetrics {
  const u = Math.min(w, h) / 1080;
  return {
    pad: Math.round(26 * u), rowPadY: Math.round(16 * u), rowMinH: Math.round(80 * u),
    ctrlH: Math.round(58 * u), toggleW: Math.round(180 * u), gap: Math.round(24 * u),
    sectionGap: Math.round(26 * u), titleGap: Math.round(10 * u), colGap: Math.round(56 * u),
  };
}

/** Type sizes shared by every section, so the whole screen has one hierarchy. */
export const TYPE = {
  get section(): number { return FS.title; },
  get label(): number { return FS.heading; },
  get hint(): number { return FS.label; },
  get control(): number { return FS.label; },
};

/** Measured width, never below the headless stub's `length * 7` (see pixiText's monospaceWidth). */
export function textW(t: PIXI.Text, size: number): number {
  return Math.max(t.width, monospaceWidth(t.text, size));
}

export class Page {
  readonly m: PageMetrics;

  constructor(
    /** Content layer, drawn in UNSCROLLED content coordinates; the scene moves it by `-scrollY`. */
    readonly layer: PIXI.Container,
    readonly w: number,
    readonly h: number,
    /** On-screen viewport the layer is clipped to. */
    readonly view: Rect,
    readonly scrollY: number,
    private readonly hits: Hit[],
    private readonly sliders: AudioSlider[],
  ) {
    this.m = pageMetrics(w, h);
  }

  /** Content rect → on-screen rect clipped to the viewport, or null when nothing of it is visible. */
  private onScreen(r: Rect): Rect | null {
    const top = Math.max(r.y - this.scrollY, this.view.y);
    const bottom = Math.min(r.y + r.h - this.scrollY, this.view.y + this.view.h);
    return bottom > top ? { x: r.x, y: top, w: r.w, h: bottom - top } : null;
  }

  hit(r: Rect, fn: () => void, sound?: AudioCue | null): void {
    const rect = this.onScreen(r);
    if (rect) this.hits.push(sound === undefined ? { rect, fn } : { rect, fn, sound });
  }

  slider(r: Rect, onDrag: (x: number) => void, onRelease?: () => void): void {
    const rect = this.onScreen(r);
    if (rect) this.sliders.push(onRelease ? { rect, onDrag, onRelease } : { rect, onDrag });
  }

  add<T extends PIXI.DisplayObject>(o: T): T {
    this.layer.addChild(o);
    return o;
  }
}

export interface Column { x: number; w: number; y: number }

/**
 * Landscape: two equal columns. Portrait: one. The outer edges are the ones every scene on the
 * notebook page uses (0.12w past the red margin rule, 0.94w on the right).
 */
export function columns(page: Page, top: number): Column[] {
  const { w, h, m } = page;
  const x0 = Math.round(w * 0.12);
  const x1 = Math.round(w * 0.94);
  if (w <= h) return [{ x: x0, w: x1 - x0, y: top }];
  const cw = Math.round((x1 - x0 - m.colGap) / 2);
  return [{ x: x0, w: cw, y: top }, { x: x1 - cw, w: cw, y: top }];
}

/** A control drawn at the right end of a row. `draw` gets the control's own box. */
export interface Control {
  w: number;
  h: number;
  draw(x: number, y: number): void;
}

export interface RowOpts {
  label?: string;
  hint?: string;
  labelColor?: number;
  labelSize?: number;
  control?: Control;
}

/** The rows of one card. Created by {@link section}; the cursor `y` is in content space. */
export class Section {
  y: number;
  readonly x0: number;
  readonly x1: number;
  private rows = 0;

  constructor(readonly page: Page, readonly col: Column, top: number) {
    this.x0 = col.x + page.m.pad;
    this.x1 = col.x + col.w - page.m.pad;
    this.y = top;
  }

  get innerW(): number { return this.x1 - this.x0; }

  /** A hairline between rows — the only thing that separates them inside a card. */
  private separate(): void {
    if (this.rows++ === 0) return;
    const g = new PIXI.Graphics();
    g.lineStyle(1.5, C.light, 1);
    g.moveTo(this.x0, this.y).lineTo(this.x1, this.y);
    this.page.add(g);
  }

  /**
   * Reserve `h` px for a custom-drawn row and return its top. Used by the rows that are not
   * "text + control" (the profile header, the volume sliders).
   */
  custom(h: number): number {
    this.separate();
    const top = this.y;
    this.y += h;
    return top;
  }

  /**
   * Label + wrapped hint on the left, `control` flush right and vertically centred. When the two do
   * not fit side by side (a wide control in a narrow column) the control drops under the text,
   * left-aligned — measured per render, so a locale that fits keeps the one-line form.
   */
  row(o: RowOpts): { top: number; h: number } {
    const { page } = this;
    const { m } = page;
    this.separate();
    const top = this.y;
    const ctrl = o.control;
    const size = o.labelSize ?? TYPE.label;

    const label = o.label ? txt(o.label, size, o.labelColor ?? C.dark, true) : null;
    const labelW = label ? textW(label, size) : 0;
    const stacked = !!ctrl && labelW + m.gap + ctrl.w > this.innerW && !o.hint;
    const textWidth = ctrl && !stacked ? this.innerW - ctrl.w - m.gap : this.innerW;
    const hint = o.hint ? txt(o.hint, TYPE.hint, C.mid, false, textWidth) : null;
    if (hint) { hint.style.breakWords = true; }

    const lineGap = Math.round(m.rowPadY * 0.4);
    const textH = (label ? label.height : 0) + (label && hint ? lineGap : 0) + (hint ? hint.height : 0);
    const bodyH = stacked ? textH + m.gap / 2 + ctrl!.h : Math.max(textH, ctrl ? ctrl.h : 0);
    const rowH = Math.max(m.rowMinH, Math.round(bodyH + m.rowPadY * 2));

    let ty = top + Math.round((rowH - bodyH) / 2) + (stacked ? 0 : Math.round((bodyH - textH) / 2));
    if (label) {
      label.anchor.set(0, 0); label.x = this.x0; label.y = ty;
      page.add(label);
      ty += label.height + (hint ? lineGap : 0);
    }
    if (hint) {
      hint.anchor.set(0, 0); hint.x = this.x0; hint.y = ty;
      page.add(hint);
    }
    if (ctrl) {
      if (stacked) ctrl.draw(this.x0, top + Math.round((rowH - bodyH) / 2) + textH + m.gap / 2);
      else ctrl.draw(this.x1 - ctrl.w, top + Math.round((rowH - ctrl.h) / 2));
    }
    this.y += rowH;
    return { top, h: rowH };
  }

  /**
   * A whole-row tap target: optional glyph, label, and a `›` at the right edge. The hit spans the
   * card's full width, so the target is the row the player sees, not the width of its words.
   */
  linkRow(o: { label: string; icon?: IconKind; color?: number; onTap: () => void; sound?: AudioCue | null }): void {
    const { page } = this;
    const { m } = page;
    this.separate();
    const top = this.y;
    const rowH = m.rowMinH;
    const cy = top + rowH / 2;
    const color = o.color ?? C.dark;
    let x = this.x0;
    if (o.icon) {
      const s = Math.round(TYPE.label * 1.2);
      const icon = buildIcon(o.icon, s, color, { variant: 'content' });
      icon.x = x; icon.y = Math.round(cy - s / 2);
      page.add(icon);
      x += s + Math.round(m.gap / 2);
    }
    const label = txt(o.label, TYPE.label, color, true);
    label.anchor.set(0, 0.5); label.x = x; label.y = cy;
    page.add(label);
    const chev = txt('›', TYPE.section, C.mid, true);
    chev.anchor.set(1, 0.5); chev.x = this.x1; chev.y = cy;
    page.add(chev);
    page.hit({ x: this.col.x, y: top, w: this.col.w, h: rowH }, o.onTap, o.sound);
    this.y += rowH;
  }
}

/**
 * One section: optional heading, then a card holding whatever rows `body` adds. The card goes in
 * behind the rows after they are laid out, because its height is their sum.
 */
export function section(page: Page, col: Column, title: string | null, body: (s: Section) => void): void {
  const { m } = page;
  if (title) {
    const t = txt(title, TYPE.section, C.dark, true);
    t.anchor.set(0, 0); t.x = col.x + Math.round(m.pad / 2); t.y = col.y;
    page.add(t);
    col.y += Math.round(t.height) + m.titleGap;
  }
  const cardAt = page.layer.children.length;
  const top = col.y;
  const s = new Section(page, col, top + Math.round(m.pad / 2));
  body(s);
  const bottom = s.y + Math.round(m.pad / 2);
  const card = sketchPanel(col.w, bottom - top, { fill: C.paper, fillAlpha: 0.92, border: C.btnOff, width: 1.8, seed: 131 + cardAt });
  card.x = col.x; card.y = top;
  page.layer.addChildAt(card, cardAt);
  col.y = bottom + m.sectionGap;
}

// ── Controls ──────────────────────────────────────────────────────────────────────────────────

/** Selected = blue fill, white bold label; unselected = paper, ink label. Shared by toggles and segments. */
function stateBox(page: Page, x: number, y: number, w: number, h: number, on: boolean, label: string, seed: number): void {
  const box = sketchPanel(w, h, { fill: on ? C.accent : C.paper, border: C.dark, width: 2, seed });
  box.x = x; box.y = y;
  page.add(box);
  const size = snapFont(TYPE.control);
  const lbl = txt(label, size, on ? 0xffffff : C.dark, on);
  lbl.anchor.set(0.5, 0.5); lbl.x = x + w / 2; lbl.y = y + h / 2;
  if (textW(lbl, size) > w - 12) lbl.scale.set((w - 12) / textW(lbl, size));
  page.add(lbl);
}

export function toggleControl(page: Page, on: boolean, label: string, seed: number, onTap: () => void): Control {
  const { toggleW: w, ctrlH: h } = page.m;
  return {
    w, h,
    draw: (x, y) => {
      stateBox(page, x, y, w, h, on, label, seed);
      page.hit({ x, y, w, h }, onTap);
    },
  };
}

/** Adjacent boxes, one selected. Only the unselected ones are tappable. */
export function segmentedControl(page: Page, options: ReadonlyArray<{ label: string; on: boolean; onTap: () => void }>): Control {
  const { ctrlH: h, gap } = page.m;
  const size = snapFont(TYPE.control);
  const segW = Math.max(Math.round(page.m.toggleW * 0.8), ...options.map((o) => Math.round(monospaceWidth(o.label, size) + gap * 1.5)));
  const g = Math.round(gap / 3);
  return {
    w: segW * options.length + g * (options.length - 1), h,
    draw: (x, y) => options.forEach((o, i) => {
      const bx = x + i * (segW + g);
      stateBox(page, bx, y, segW, h, o.on, o.label, 71 + i);
      if (!o.on) page.hit({ x: bx, y, w: segW, h }, o.onTap);
    }),
  };
}

/**
 * A button sized to its label. `primary` is the one filled button a screen may have (log in);
 * everything else is the outlined secondary form. `fn = null` → disabled (greyed, inert).
 */
export function buttonControl(page: Page, label: string, icon: IconKind | null, fn: (() => void) | null, primary = false): Control {
  const { ctrlH: h, gap } = page.m;
  const size = snapFont(TYPE.control);
  const w = Math.round(monospaceWidth(label, size) + (icon ? buttonLabelIconW(size) : 0) + gap * 1.5);
  const enabled = fn !== null;
  const ink = !enabled ? C.mid : primary ? 0xffffff : C.accent;
  return {
    w, h,
    draw: (x, y) => {
      const box = sketchPanel(w, h, {
        fill: !enabled ? C.btnDis : primary ? C.accent : C.paper,
        border: !enabled ? C.btnOff : C.accent, width: 2.2, seed: 91,
      });
      box.x = x; box.y = y;
      page.add(box);
      const content = new PIXI.Container();
      drawButtonLabel(content, x, y, w, h, label, icon, ink, size, primary ? { variant: 'active' } : { variant: 'content' });
      page.add(content);
      if (fn) page.hit({ x, y, w, h }, fn);
    },
  };
}
