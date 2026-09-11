// layoutAudit.ts — a geometry auditor that runs INSIDE the page, against the real display tree.
//
// Why it lives at this layer and not in test:ui: the headless harness's `measureText` is a flat
// `length * 7` per character and ignores fontSize (test/harness/pixiHeadless.ts), so every
// width-driven portrait defect — a label wrapping to three lines and pushing into the badge under
// it, a name colliding with the number right of it — is structurally invisible there. See the
// header of test/ui/titlesPortraitOverlap.ui.ts, which had to move its real assertion into a
// separate arithmetic test for exactly this reason. Only a real browser measures real glyphs, and
// `window.__nwE2E.app` (entries/web-e2e.ts) is the handle onto the real stage.
//
// `auditLayout` is handed to `page.evaluate`, so it is serialized by `Function.prototype.toString`
// and re-parsed in the page: it may NOT reference anything outside its own body — no imports, no
// module-level constants, no helper functions declared next to it. Every helper is nested inside.
// Type-only imports are fine (erased at compile time).

/** Axis-aligned rect in CSS pixels of the renderer's screen space. */
export interface AuditRect { x: number; y: number; w: number; h: number }

export interface AuditFinding {
  /**
   * `overlap` — two visible labels whose ink boxes intersect. `offscreen` — a visible label
   * (partly) outside the canvas. `overflow` — a label spilling out of the button/panel box it was
   * drawn into, which is what a too-narrow portrait column actually produces: the text does not
   * collide with another label, it just runs past its own frame and over whatever is beside it.
   * `tiny` — a label rendered below the design's smallest font token, i.e. shrunk to fit rather
   * than laid out, and unreadable on a phone. `covered` — a label painted over by opaque art drawn
   * after it (a progress bar running through a title, say): still "visible" to the tree, gone to
   * the eye.
   */
  kind: 'overlap' | 'offscreen' | 'overflow' | 'tiny' | 'covered' | 'placeholder';
  a: string;
  /** The other label for `overlap`, `'frame'` for `overflow`, empty for `offscreen`. */
  b: string;
  rectA: AuditRect;
  rectB: AuditRect;
  /** Intersection area as a fraction of the smaller label's area (0 for `offscreen`). */
  frac: number;
}

export interface AuditOptions {
  /** Report an overlap only when it covers at least this fraction of the smaller label. */
  minFrac: number;
  /** ...and at least this many square pixels. Together these ignore sub-pixel adjacency. */
  minPx: number;
  /** Design-space width/height the layout contains into — portrait's 1080x1920 reference box. */
  designW: number;
  designH: number;
  /**
   * Smallest ink height (design px) a label may render at before it counts as shrunk-to-fit.
   * `FS.micro` is the design's own floor, so anything whose whole ink box is shorter than one
   * micro font size has been scaled below what any scene is allowed to ask for.
   */
  minInkDesignPx: number;
}

export interface AuditResult {
  /** `__nwE2E.state.screen` at the time of the audit. */
  screen: string;
  /** Visible, unoccluded labels considered — a sanity check that the walk found the scene at all. */
  labels: number;
  findings: AuditFinding[];
}

/**
 * Walks the live display tree and reports labels that collide, spill out of their own frame, or
 * fall off the canvas.
 *
 * Three things make this quiet enough to be a gate rather than a noise generator:
 *
 *  - **Masks are honoured.** `getBounds()` knows nothing about masks, so a row scrolled out of a
 *    list still reports a full-size box somewhere. Every node's bounds are intersected with the
 *    bounds of every ancestor mask; a label clipped to nothing is dropped entirely.
 *  - **Occlusion is honoured.** A modal legitimately covers the screen behind it. Any label drawn
 *    *before* an opaque, screen-covering node that contains it is dropped, so a dialog is compared
 *    against itself and not against the scene it sits on.
 *  - **Ink padding is removed.** `pixiText.ts` inflates every text canvas by ~15% of the font size
 *    to stop CJK glyph tops being clipped, so raw bounds overlap for labels that only *touch*.
 *    Each box is deflated by 10% of its height before intersecting (≈ that padding).
 */
export function auditLayout(opts: AuditOptions): AuditResult {
  interface NodeLike {
    visible: boolean;
    renderable: boolean;
    alpha: number;
    name: string | null;
    text?: unknown;
    mask?: NodeLike | null;
    children?: NodeLike[];
    /** Present on `PIXI.Graphics` only — what it was actually told to draw. */
    geometry?: { graphicsData?: Array<{ shape?: { type?: number }; fillStyle?: { visible?: boolean; alpha?: number } }> };
    getBounds(skipUpdate?: boolean): { x: number; y: number; width: number; height: number };
  }
  const e2e = (window as unknown as {
    __nwE2E?: {
      app?: {
        stage: NodeLike;
        renderer: { screen: { width: number; height: number } };
      };
      state?: { screen?: string };
    };
  }).__nwE2E;
  const app = e2e?.app;
  if (!app) throw new Error('__nwE2E.app is missing — this is not the web-e2e build');

  const screenW = app.renderer.screen.width;
  const screenH = app.renderer.screen.height;
  const screenArea = screenW * screenH;

  const rectOf = (n: NodeLike): AuditRect => {
    const b = n.getBounds(false);
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  };
  const intersect = (a: AuditRect, b: AuditRect): AuditRect => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w);
    const bo = Math.min(a.y + a.h, b.y + b.h);
    return { x, y, w: Math.max(0, r - x), h: Math.max(0, bo - y) };
  };
  const contains = (outer: AuditRect, inner: AuditRect): boolean =>
    outer.x <= inner.x + 0.5 && outer.y <= inner.y + 0.5 &&
    outer.x + outer.w >= inner.x + inner.w - 0.5 &&
    outer.y + outer.h >= inner.y + inner.h - 0.5;

  /**
   * The string a node carries, or null if it is not a label. Two shapes exist: a live `PIXI.Text`
   * (`.text`), and the baked sprites `render/fastText.ts` hands out instead on a real renderer —
   * those are plain `Sprite`s/`Container`s, indistinguishable from an icon without the `txt:` tag
   * that module stamps on `name` for exactly this audit.
   */
  const labelOf = (n: NodeLike): string | null => {
    if (typeof n.text === 'string' && n.text.length > 0) return n.text;
    if (typeof n.name === 'string' && n.name.indexOf('txt:') === 0) return n.name.slice(4);
    return null;
  };

  /**
   * `overlay` marks a node inside a container the product named `overlay:*` — an onboarding
   * spotlight, for now. Such a layer is MEANT to cover the screen it points at, so it is compared
   * against itself and never against the scene under it; its own internal layout is still judged.
   */
  interface Label { order: number; label: string; rect: AuditRect; overlay: boolean }
  interface Cover { order: number; rect: AuditRect }
  /**
   * A box a label could have been drawn INTO. Every `sketchPanel`/`sketchButton` puts its fill
   * down as one leaf `Graphics` of exactly the panel rect (see sketchUi.ts), so leaves are the
   * right population to look in: a `Container`'s bounds are the union of its children and would
   * grow to swallow the very overflow this is looking for.
   */
  interface Frame { order: number; rect: AuditRect; alpha: number; solid: boolean; overlay: boolean }

  /**
   * True when this node paints its whole bounding box — a `Graphics` with a filled rect (every
   * `sketchPanel` fill, every bar, every scrim). Deliberately narrow, because bounds and painted
   * area are not the same thing: a `Sprite` of a baked ring (`avatar.ts`'s rim) and a stroke-only
   * `Graphics` both report a full box while painting an outline, and treating either as solid
   * reports every letter inside a circular avatar as painted over.
   */
  const isSolidBox = (n: NodeLike): boolean => {
    const data = n.geometry?.graphicsData;
    if (!data || !data.length) return false;
    for (const d of data) {
      // PIXI.SHAPES: RECT = 1, RREC = 4 — the two whose fill covers the whole bound.
      const t = d.shape?.type;
      if (t !== 1 && t !== 4) continue;
      if (d.fillStyle?.visible && (d.fillStyle.alpha ?? 1) >= 0.6) return true;
    }
    return false;
  };
  const labels: Label[] = [];
  const covers: Cover[] = [];
  const frames: Frame[] = [];
  let order = 0;

  // Pre-order DFS = PIXI's own paint order, so a higher `order` is drawn later, i.e. on top.
  const walk = (n: NodeLike, clip: AuditRect | null, parentAlpha: number, inOverlay: boolean): void => {
    if (!n.visible || n.alpha <= 0.02) return;
    const alpha = parentAlpha * n.alpha;
    if (alpha <= 0.05) return;

    let nextClip = clip;
    if (n.mask) {
      const m = rectOf(n.mask);
      nextClip = nextClip ? intersect(nextClip, m) : m;
      if (nextClip.w <= 0 || nextClip.h <= 0) return;   // subtree is clipped away entirely
    }

    const overlay = inOverlay || (typeof n.name === 'string' && n.name.indexOf('overlay:') === 0);
    const mine = order++;
    if (n.renderable) {
      const raw = rectOf(n);
      const box = nextClip ? intersect(raw, nextClip) : raw;
      if (box.w > 0 && box.h > 0) {
        const label = labelOf(n);
        if (label !== null) {
          labels.push({ order: mine, label, rect: box, overlay });
        } else if (!n.children?.length) {
          const area = box.w * box.h;
          if (alpha >= 0.85 && area >= 0.45 * screenArea) {
            // An opaque, screen-covering fill: a modal scrim, a full-bleed page background, the
            // desk surround. Anything drawn before one of these and inside it cannot be seen.
            covers.push({ order: mine, rect: box });
          } else if (box.w >= 12 && box.h >= 12 && area <= 0.35 * screenArea) {
            frames.push({ order: mine, rect: box, alpha, solid: isSolidBox(n), overlay });
          }
        }
      }
    }
    const kids = n.children;
    if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]!, nextClip, alpha, overlay);
  };
  walk(app.stage, null, 1, false);

  const visible = labels.filter((l) => !covers.some((c) => c.order > l.order && contains(c.rect, l.rect)));

  const findings: AuditFinding[] = [];
  const empty: AuditRect = { x: 0, y: 0, w: 0, h: 0 };

  /** The box minus the anti-clip padding `pixiText.ts` bakes into every text canvas. */
  const ink = (r: AuditRect): AuditRect => {
    const pad = Math.min(r.h * 0.1, 4);
    return { x: r.x + pad * 0.5, y: r.y + pad, w: Math.max(0, r.w - pad), h: Math.max(0, r.h - pad * 2) };
  };

  // Design px per screen px: portrait contains into designW x designH, so the smaller ratio wins
  // (on a screen squatter than the reference box, height binds and side bands take the slack).
  const scale = Math.min(screenW / opts.designW, screenH / opts.designH);

  for (const l of visible) {
    if (l.rect.x < -0.5 || l.rect.y < -0.5 ||
        l.rect.x + l.rect.w > screenW + 0.5 || l.rect.y + l.rect.h > screenH + 0.5) {
      findings.push({ kind: 'offscreen', a: l.label, b: '', rectA: l.rect, rectB: empty, frac: 0 });
    }
  }

  for (const l of visible) {
    const box = ink(l.rect);
    const boxArea = box.w * box.h;
    if (boxArea <= 0) continue;

    // Painted over by a solid fill drawn after it: the tree still calls this label visible, the eye
    // does not. Z-order IS the whole test here — dropping it (to also catch a bar drawn *under* a
    // title) turns every ordinary button into a finding, since a fill that is a pixel tighter than
    // its own label reads as "swallows most of it and stops".
    for (const f of frames) {
      if (f.order < l.order || f.alpha < 0.6 || !f.solid || f.overlay !== l.overlay) continue;
      const hit = intersect(box, f.rect);
      if (hit.w * hit.h > boxArea * 0.35) {
        findings.push({
          kind: 'covered', a: l.label, b: '', rectA: l.rect, rectB: f.rect,
          frac: Math.round((hit.w * hit.h / boxArea) * 100) / 100,
        });
        break;
      }
    }

    // Not a layout defect, but free to catch while every string on the screen is in hand, and
    // never intentional: `${maybeUndefined}` reaching a player.
    if (/(undefined|null|NaN)/.test(l.label)) {
      findings.push({ kind: 'placeholder', a: l.label, b: '', rectA: l.rect, rectB: empty, frac: 0 });
    }

    if (box.h / scale < opts.minInkDesignPx) {
      findings.push({ kind: 'tiny', a: l.label, b: '', rectA: l.rect, rectB: empty, frac: 0 });
    }
    // Which box was this label drawn into? The tree does not say, so the question is answered the
    // only way that holds across every scene: if ANY box painted under the label holds all of it,
    // the label fits something and there is nothing to report. Asking instead "is it inside the
    // TIGHTEST box under it" reads the art as a frame — the crossed-pencils motif inside the
    // lobby's hero button is a leaf sprite smaller than the button it decorates, and every label
    // on that button would be reported as escaping it.
    let frame: AuditRect | null = null;
    let covered = boxArea * 0.5;   // a candidate must hold at least half the ink to count as its box
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    for (const f of frames) {
      if (f.order > l.order || f.overlay !== l.overlay || f.rect.w * f.rect.h < boxArea * 1.2) continue;
      if (contains(f.rect, box)) { frame = null; break; }   // fits something — done
      if (cx < f.rect.x || cx > f.rect.x + f.rect.w || cy < f.rect.y || cy > f.rect.y + f.rect.h) continue;
      const inside = intersect(box, f.rect);
      const area = inside.w * inside.h;
      if (area <= covered) continue;
      covered = area;
      frame = f.rect;
    }
    if (!frame) continue;
    const tol = Math.max(3, box.h * 0.15);
    const escape = Math.max(
      frame.x - box.x, box.x + box.w - (frame.x + frame.w),
      frame.y - box.y, box.y + box.h - (frame.y + frame.h),
    );
    if (escape > tol) {
      findings.push({
        kind: 'overflow', a: l.label, b: 'frame',
        rectA: l.rect, rectB: frame,
        frac: Math.round((escape / Math.max(1, box.w)) * 100) / 100,
      });
    }
  }

  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i]!;
      const b = visible[j]!;
      // A label drawn twice at a 1-2px offset is a hand-rolled drop shadow, not a collision.
      if (a.overlay !== b.overlay) continue;   // an overlay may cover the scene it sits on
      if (a.label === b.label &&
          Math.abs(a.rect.x - b.rect.x) <= 4 && Math.abs(a.rect.y - b.rect.y) <= 4) continue;
      const ia = ink(a.rect);
      const ib = ink(b.rect);
      const hit = intersect(ia, ib);
      const area = hit.w * hit.h;
      if (area <= 0) continue;
      const smaller = Math.min(ia.w * ia.h, ib.w * ib.h);
      if (smaller <= 0) continue;
      const frac = area / smaller;
      if (area < opts.minPx || frac < opts.minFrac) continue;
      findings.push({
        kind: 'overlap',
        a: a.label, b: b.label,
        rectA: a.rect, rectB: b.rect,
        frac: Math.round(frac * 100) / 100,
      });
    }
  }

  return { screen: e2e?.state?.screen ?? '?', labels: visible.length, findings };
}
