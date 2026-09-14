// layoutAudit.ts — a geometry auditor that runs INSIDE the page, against the real display tree.
//
// Why it lives at this layer and not in test:ui: the headless harness's `measureText` is a flat
// `length * 7` per character and ignores fontSize (test/harness/pixiHeadless.ts), so every
// width-driven portrait defect — a label wrapping to three lines and pushing into the badge under
// it, a name colliding with the number right of it — is structurally invisible there. See the
// header of test/ui/titlesPortraitOverlap.ui.ts, which had to move its real assertion into a
// separate arithmetic test for exactly this reason. Only a real browser measures real glyphs, and
// `globalThis.__nwE2E.app` (testing/instrumentViews.ts) is the handle onto the real stage.
//
// It lives in `src/` rather than under `test/` because it has two callers, and only one of them
// is a test process: `test/browser/portraitLayout.spec.ts` imports it to hand to `page.evaluate`,
// and `entries/wechat-layout.ts` BUNDLES it into a mini-game package that audits itself from the
// inside (§50.6 — the mini-game has no appservice, so no external automation can reach in).
//
// `auditLayout` is handed to `page.evaluate`, so it is serialized by `Function.prototype.toString`
// and re-parsed in the page: it may NOT reference anything outside its own body — no imports, no
// module-level constants, no helper functions declared next to it. Every helper is nested inside.
// Type-only imports are fine (erased at compile time).

// The one value import: `auditOptionsFor` below needs the shipped legibility floor. It is NOT
// referenced from inside `auditLayout`'s body, which is what the serialization rule above forbids.
import { fontFloorDesignPx } from '../render/fontScale';

/** Axis-aligned rect in CSS pixels of the renderer's screen space. */
export interface AuditRect { x: number; y: number; w: number; h: number }

export interface AuditFinding {
  /**
   * `overlap` — two visible labels whose ink boxes intersect. `offscreen` — a visible label
   * (partly) outside the canvas. `overflow` — a label spilling out of the button/panel box it was
   * drawn into, which is what a too-narrow portrait column actually produces: the text does not
   * collide with another label, it just runs past its own frame and over whatever is beside it.
   * `tiny` — a label whose effective font size (its own size times whatever local scale sits above
   * it) is below the legibility floor the font scale promised for this viewport: either a size
   * asked for off the scale, or — far more often — a group shrunk to fit a box too narrow for it.
   * `icon` - the same gate applied to a hand-drawn icon (render/iconTag.ts stamps the size it was
   * asked for): a pictogram carries no fallback the way a word does. An unreadable label is still a
   * word-shaped smudge in a known place and a known length; an unreadable glyph is just a smudge.
   * So an icon may not be drawn below the size the font scale guarantees text.
   * `covered` — a label painted over by opaque art drawn
   * after it (a progress bar running through a title, say): still "visible" to the tree, gone to
   * the eye.
   */
  kind: 'overlap' | 'offscreen' | 'overflow' | 'tiny' | 'icon' | 'covered' | 'placeholder';
  a: string;
  /**
   * The other label for `overlap`, `'frame'` for `overflow`, empty for `offscreen`. For `tiny` it
   * is the DIAGNOSIS — `font=<px> scale=<x>` — because "this label is too small" is never
   * actionable on its own: either the scene asked for a size below the floor, or something above
   * it shrank a group to fit (`row.scale.set(maxW / row.width)`, `drawButtonLabel`'s solo fit),
   * and the fix is completely different. `font` is the style's own fontSize in design px (only a
   * live `PIXI.Text` carries one; a baked label reports `?`), `scale` is the local scale on top of
   * the layout's design→screen factor, so 1.00 means nothing shrank it.
   */
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
   * Smallest EFFECTIVE font size (design px) a label may render at — `fontFloorDesignPx(scale)`
   * for this viewport (render/fontScale.ts).
   *
   * Read off the label's own font size, not its box: a baked label's bounds are its trimmed glyph
   * box (~0.96x the font size) and a live `PIXI.Text`'s are its line box (~1.35x), so a
   * bounds-derived gate has to be loose enough to accept the tighter of the two and then no
   * longer separates "asked for a size below the floor" from "asked for a legible one". Live Text
   * carries `style.fontSize`; baked labels carry `fsPx` (render/fastText.ts stamps it for exactly
   * this). A label with neither falls back to the box, deflated, which is what this used to be.
   */
  minInkDesignPx: number;
  /**
   * Smallest EFFECTIVE size (design px) a hand-drawn icon may be drawn at. The same number as
   * {@link minInkDesignPx}: an icon is held to the floor the font scale guarantees text, no more.
   *
   * No more, because a stricter icon threshold is not a gate anyone could keep green. Every icon on
   * a phone is small for the same reason every LABEL is - portrait's design width is a fixed 1080
   * against a 390-px screen, so the whole page renders at 0.36x (UI_DESIGN_LOG_2026-08.md 49.1,
   * still open). A threshold high enough to catch e.g. the daily check-in grid's 34-design-px
   * reward glyph would report most of the game's icons with it, and a gate that is always red is
   * not a gate. This one catches the narrower thing nothing was watching at all: an icon drawn
   * smaller than the text beside it is allowed to be.
   */
  minIconDesignPx: number;
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
    /** Present on `PIXI.Text` only. */
    style?: { fontSize?: unknown };
    /** Stamped by render/fastText.ts on every baked label — its font size in design px. */
    fsPx?: unknown;
    /** Stamped by render/iconTag.ts on every hand-drawn icon - the size it was asked for. */
    iconPx?: unknown;
    /** Populated by `getBounds()`; `a` is the horizontal world scale. */
    worldTransform?: { a: number };
    /** Present on `PIXI.Graphics` only — what it was actually told to draw. */
    geometry?: { graphicsData?: Array<{ shape?: { type?: number }; fillStyle?: { visible?: boolean; alpha?: number } }> };
    getBounds(skipUpdate?: boolean): { x: number; y: number; width: number; height: number };
  }
  // `globalThis`, not `window`: this same function body runs inside the WeChat mini-game runtime
  // (entries/wechat-layout.ts), which has no `window` of its own. Chromium answers to both.
  const e2e = (globalThis as unknown as {
    __nwE2E?: {
      app?: {
        stage: NodeLike;
        renderer: { screen: { width: number; height: number } };
      };
      state?: { screen?: string };
    };
  }).__nwE2E;
  const app = e2e?.app;
  if (!app) throw new Error('__nwE2E.app is missing — this is not a web-e2e / wechat-layout build');

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
   * The icon identity a node carries, or null if it is not one. `render/iconTag.ts` stamps
   * `icon:<kind-or-url>`; the url form is shortened to its file name, which is what actually names
   * the picture (`.../tabicons/coin_content.png` becomes `coin_content`).
   */
  const iconOf = (n: NodeLike): string | null => {
    if (typeof n.name !== 'string' || n.name.indexOf('icon:') !== 0) return null;
    const id = n.name.slice(5);
    const slash = id.lastIndexOf('/');
    const base = slash >= 0 ? id.slice(slash + 1) : id;
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
  };

  /**
   * `overlay` marks a node inside a container the product named `overlay:*` — an onboarding
   * spotlight, for now. Such a layer is MEANT to cover the screen it points at, so it is compared
   * against itself and never against the scene under it; its own internal layout is still judged.
   */
  interface Label {
    order: number; label: string; rect: AuditRect; overlay: boolean;
    /** Style fontSize if this is a live Text, else null (a baked label has no style). */
    fontPx: number | null;
    /** World horizontal scale — divided by the design scale below to get the local shrink. */
    worldScale: number;
  }
  /** A tagged icon: the size it was ASKED for, plus whatever local scale sits above it. */
  interface Icon { id: string; askedPx: number; rect: AuditRect; worldScale: number }
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
  const icons: Icon[] = [];
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
        // Icons are tagged on the CONTAINER that holds the fitted sprite, so this runs before the
        // leaf-only `frames` branch below and does not stop the walk descending into the sprite.
        const icon = iconOf(n);
        if (icon !== null) {
          const asked = Number(n.iconPx);
          if (Number.isFinite(asked) && asked > 0) {
            icons.push({ id: icon, askedPx: asked, rect: box, worldScale: n.worldTransform?.a ?? 1 });
          }
        }
        const label = labelOf(n);
        if (label !== null) {
          const own = Number(typeof n.fsPx === 'number' ? n.fsPx : n.style?.fontSize);
          labels.push({
            order: mine, label, rect: box, overlay,
            fontPx: Number.isFinite(own) && own > 0 ? own : null,
            worldScale: n.worldTransform?.a ?? 1,
          });
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
    // ⚠ `\b`, spelled as an escape. Until 2026-09-12 this line held two literal BACKSPACE bytes
    // (0x08) where the word boundaries were meant — the regex matched a control character and
    // therefore nothing, so the `placeholder` kind had never once fired. It survived because
    // the file lived under `test/` and `npm run lint` only scans `src/`; moving it here is what
    // surfaced it (eslint `no-control-regex`).
    if (/\b(undefined|null|NaN)\b/.test(l.label)) {
      findings.push({ kind: 'placeholder', a: l.label, b: '', rectA: l.rect, rectB: empty, frac: 0 });
    }

    // Local scale on top of the layout's own design→screen factor: 1 means nothing shrank this
    // label, 0.68 means a shrink-to-fit group above it took a third off.
    const local = scale > 0 ? l.worldScale / scale : 1;
    // No font size to read (a `PIXI.Text` subclass with a non-numeric style, say): fall back to the
    // ink box and the loosest of the two box-to-font ratios, so the fallback cannot cry wolf.
    const effective = l.fontPx !== null ? l.fontPx * local : (box.h / scale) / 0.77;
    if (effective < opts.minInkDesignPx) {
      findings.push({
        kind: 'tiny', a: l.label,
        b: `font=${l.fontPx ?? '?'} scale=${local.toFixed(2)}`,
        rectA: l.rect, rectB: empty,
        frac: Math.round(effective * 10) / 10,
      });
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
      // "Fits something" is answered by ANY box under the label — a decorative panel the label sits
      // comfortably inside is exactly as good an answer as a button fill.
      if (contains(f.rect, box)) { frame = null; break; }   // fits something — done
      // ...but only a SOLID fill may be ACCUSED of being the box a label escaped from. A frame is a
      // thing a label was drawn INTO, and in this codebase that is always a `sketchPanel` /
      // `sketchButton` fill — one leaf `Graphics` of a filled rect. Art is not: the result screen's
      // falling-star sprite sits behind the award labels on bare paper with no panel anywhere, and
      // without this rule it was the only candidate under them, so every award line read as
      // escaping a decoration (layout sweep §49). Keeping the "fits" half open to every box is what
      // stops the narrower accusation from creating NEW false positives — measured: restricting
      // both halves made four scene titles (which sit inside a non-solid header backdrop) start
      // reporting against the back-button pill instead.
      if (!f.solid) continue;
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

  // Icons, same gate as `tiny` and the same diagnosis format: the size asked for, and the local
  // scale on top of it, because "make it bigger" and "stop shrinking the group it is in" are
  // different fixes. Occlusion is not re-tested here - an icon under a modal is drawn under it in
  // paint order too, and the `covers` list is built from labels' needs; an icon that IS covered is
  // reported at its own size, which is still a true statement about the scene that drew it.
  for (const ic of icons) {
    const local = scale > 0 ? ic.worldScale / scale : 1;
    const effective = ic.askedPx * local;
    if (effective < opts.minIconDesignPx) {
      findings.push({
        kind: 'icon', a: ic.id,
        b: `icon=${Math.round(ic.askedPx)} scale=${local.toFixed(2)}`,
        rectA: ic.rect, rectB: empty,
        frac: Math.round(effective * 10) / 10,
      });
    }
  }

  return { screen: e2e?.state?.screen ?? '?', labels: visible.length, findings };
}

/**
 * Overlap thresholds — the only audit options that do not depend on the viewport.
 * `minFrac`: report an overlap only when it covers this fraction of the smaller label.
 * `minPx`: ...and at least this many square pixels. Together they ignore sub-pixel adjacency.
 */
export const OVERLAP_THRESHOLDS = { minFrac: 0.12, minPx: 40 } as const;

/**
 * Audit options for one shape. Everything is shared except the `tiny` gate, which is the viewport's
 * own legibility floor (render/fontScale.ts): the app lifts every font token to
 * `fontFloorDesignPx(scale)`, so nothing on screen may measure below it.
 *
 * Deriving it from the shipped function rather than restating a number is what makes this a gate on
 * the floor rather than a second opinion about it: re-tune `MIN_LEGIBLE_CSS_PX` and every sweep
 * demands the new floor on its next run.
 *
 * The two callers know the design box by different routes and neither can use the other's:
 * `portraitLayout.spec.ts` runs in a Playwright process with no DOM, so it re-derives the box from
 * the viewport size (importing `ScalingManager` would drag PIXI and `@nw/engine/config` in);
 * `entries/wechat-layout.ts` runs INSIDE the app and simply reads `layout.designWidth` and
 * `gameLayer.scale.x` off the live objects. Hence a function over three numbers rather than over a
 * viewport.
 */
export function auditOptionsFor(designW: number, designH: number, designScale: number): AuditOptions {
  return {
    ...OVERLAP_THRESHOLDS,
    designW,
    designH,
    minInkDesignPx: fontFloorDesignPx(designScale),
    minIconDesignPx: fontFloorDesignPx(designScale),
  };
}
