import * as PIXI from 'pixi.js-legacy';
import type { ChapterMap, ChapterNode } from '../../game';
import { parseLevelId } from '../../game/campaign/progress';
import { ui as C, txt, seedFor } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { SketchPen } from '../../render/sketch';
import { palette } from '../../render/theme';
import { t } from '../../i18n';

// ── Pure drawing helpers for CampaignMapScene ─────────────────────────────────
//
// Extracted from the scene class (form① partial split, client-modules.md §split
// convention): these take explicit params and hold no scene state, so they were
// pulled into free functions while the orchestration methods (buildToc/
// buildChapter/buildHeader) stay on the class.

/** Draw one level node; returns the pulse ring Graphics if `isCurrent`. */
export function drawNode(
  root: PIXI.Container, cx: number, cy: number, node: ChapterNode, i: number,
  unlocked: boolean, isCleared: boolean, isCurrent: boolean,
  starCount: number, pending: boolean, h: number,
): PIXI.Graphics | null {
  const r = Math.round(h * 0.032);
  const parsed = parseLevelId(node.levelId);
  const lvIndex = parsed?.lvIndex ?? (i + 1);

  const g = new PIXI.Graphics();
  const pen = new SketchPen(g, seedFor(cx, cy, r));
  if (unlocked) {
    g.beginFill(isCleared ? C.gold : C.paper, isCleared ? 0.22 : 1);
    g.drawCircle(cx, cy, r); g.endFill();
    pen.circle(cx, cy, r, { color: isCleared ? C.gold : C.accent, width: 2.4, jitter: 1.0 });
  } else {
    // Locked — faint pencil outline only.
    pen.circle(cx, cy, r, { color: palette.pencilLight, width: 1.6, jitter: 1.2, double: false });
  }
  root.addChild(g);

  const num = txt(String(lvIndex), snapFont(Math.round(r * 1.0)), unlocked ? (isCleared ? C.gold : C.dark) : C.btnOff, true);
  num.anchor.set(0.5); num.x = cx; num.y = cy;
  root.addChild(num);

  if (unlocked && isCleared) {
    // Three hand-drawn star glyphs: earned in gold, unearned dimmed (replaces ★/☆ text).
    const starSz = Math.round(r * 0.62);
    const gap = Math.round(starSz * 0.2);
    const rowW = starSz * 3 + gap * 2;
    const sy = cy + r + Math.round(h * 0.004);
    for (let i = 0; i < 3; i++) {
      const ic = buildIcon('star', starSz, i < starCount ? C.gold : C.btnOff);
      ic.x = cx - rowW / 2 + i * (starSz + gap); ic.y = sy;
      root.addChild(ic);
    }
  } else if (unlocked && pending) {
    const pd = txt(t('campaign.pending'), snapFont(Math.round(r * 0.55)), C.mid);
    pd.anchor.set(0.5, 0); pd.x = cx; pd.y = cy + r + Math.round(h * 0.004);
    root.addChild(pd);
  }

  if (isCurrent) {
    const ring = new PIXI.Graphics();
    new SketchPen(ring, seedFor(cx, cy, r + 5)).circle(0, 0, r + Math.round(h * 0.012), {
      color: C.accent, width: 2.6, jitter: 0.9, double: false,
    });
    ring.x = cx; ring.y = cy;
    root.addChild(ring);
    return ring;
  }
  return null;
}

/** Pencil dashed trail through the nodes (or an explicit point list). */
export function drawTrail(
  root: PIXI.Container, map: ChapterMap, px: (n: number) => number, py: (n: number) => number, h: number,
): void {
  const pts = (map.path && map.path !== 'auto' ? map.path : map.nodes).map((p) => ({ x: px(p.x), y: py(p.y) }));
  if (pts.length < 2) return;
  const g = new PIXI.Graphics();
  const pen = new SketchPen(g, seedFor(pts[0]!.x, pts[0]!.y, pts.length));
  const dash = Math.round(h * 0.018), gapLen = Math.round(h * 0.012);
  const nodeR = Math.round(h * 0.032);
  for (let s = 0; s < pts.length - 1; s++) {
    const a0 = pts[s]!, b0 = pts[s + 1]!;
    const fullLen = Math.hypot(b0.x - a0.x, b0.y - a0.y);
    if (fullLen <= nodeR * 2) continue;
    const ux = (b0.x - a0.x) / fullLen, uy = (b0.y - a0.y) / fullLen;
    // Trim both ends so the trail stops at the node circle's edge instead of crossing its center.
    const a = { x: a0.x + ux * nodeR, y: a0.y + uy * nodeR };
    const len = fullLen - nodeR * 2;
    for (let d = 0; d < len; d += dash + gapLen) {
      const d2 = Math.min(len, d + dash);
      pen.line(a.x + ux * d, a.y + uy * d, a.x + ux * d2, a.y + uy * d2, {
        color: palette.pencilLight, width: 1.8, jitter: 0.7, taper: 0.8, double: false,
      });
    }
  }
  root.addChildAt(g, 0); // behind nodes, but the bg paper is on the container, not the page root
}

/** Procedural doodle decor (start/boss/rack/flag/tent/tree/rock). */
export function drawDecor(root: PIXI.Container, kind: string, x: number, y: number, s: number): void {
  const g = new PIXI.Graphics();
  const pen = new SketchPen(g, seedFor(x, y, s));
  switch (kind) {
    case 'start': {
      pen.line(x, y - s, x, y + s, { color: palette.pencil, width: 2.2 });
      const fl = new PIXI.Graphics();
      fl.beginFill(C.green, 0.85); fl.drawPolygon([x, y - s, x + s * 1.3, y - s * 0.6, x, y - s * 0.2]); fl.endFill();
      root.addChild(fl);
      const lbl = txt(t('campaign.markerStart'), snapFont(Math.round(s * 0.62)), C.green, true);
      lbl.anchor.set(0.5, 0); lbl.x = x; lbl.y = y + s * 0.2; root.addChild(lbl);
      break;
    }
    case 'boss': {
      pen.line(x, y - s, x, y + s, { color: palette.pencil, width: 2.2 });
      const fl = new PIXI.Graphics();
      fl.beginFill(C.red, 0.85); fl.drawPolygon([x, y - s, x + s * 1.4, y - s * 0.55, x, y - s * 0.1]); fl.endFill();
      root.addChild(fl);
      const lbl = txt(t('campaign.markerBoss'), snapFont(Math.round(s * 0.62)), C.red, true);
      lbl.anchor.set(0.5, 0); lbl.x = x; lbl.y = y + s * 0.2; root.addChild(lbl);
      break;
    }
    case 'rack': // spear rack — an X of two strokes on a baseline
      pen.line(x - s, y + s, x + s, y - s, { color: palette.pencilLight, width: 2.0, double: false });
      pen.line(x - s, y - s, x + s, y + s, { color: palette.pencilLight, width: 2.0, double: false });
      pen.line(x - s * 1.2, y + s, x + s * 1.2, y + s, { color: palette.pencilLight, width: 1.6, double: false });
      break;
    case 'flag':
    case 'banner': {
      pen.line(x, y - s, x, y + s, { color: palette.pencilLight, width: 2.0 });
      const fl = new PIXI.Graphics();
      fl.beginFill(C.accent, 0.55); fl.drawPolygon([x, y - s, x + s, y - s * 0.6, x, y - s * 0.2]); fl.endFill();
      root.addChild(fl);
      break;
    }
    case 'tent':
      pen.line(x - s, y + s, x, y - s, { color: palette.pencilLight, width: 2.0, double: false });
      pen.line(x + s, y + s, x, y - s, { color: palette.pencilLight, width: 2.0, double: false });
      pen.line(x - s, y + s, x + s, y + s, { color: palette.pencilLight, width: 1.6, double: false });
      break;
    case 'tree':
      pen.line(x, y + s, x, y - s * 0.2, { color: palette.pencil, width: 2.0, double: false });
      pen.circle(x, y - s * 0.5, s * 0.7, { color: palette.pencilLight, width: 1.6, double: false });
      break;
    case 'rock':
      pen.circle(x, y, s * 0.7, { color: palette.pencilLight, width: 1.8, double: false });
      break;
    default:
      return; // unknown kind — forward-compatible skip
  }
  root.addChild(g);
}

/** A taped-shut overlay on a locked TOC card. */
export function drawTape(card: PIXI.Graphics, w: number, h: number, seed: number): void {
  const tw = Math.round(w * 0.18), th = Math.round(h * 0.5);
  const tape = new PIXI.Graphics();
  tape.beginFill(C.gold, 0.28); tape.drawRect(-tw / 2, -th / 2, tw, th); tape.endFill();
  new SketchPen(tape, seed).rect(-tw / 2, -th / 2, tw, th, { color: C.gold, width: 1.4, alpha: 0.5, double: false });
  tape.x = w * 0.5; tape.y = h * 0.5; tape.rotation = -0.35;
  card.addChild(tape);

  // Stamped word across the tape (reads with the tape's own tilt).
  const label = txt(t('campaign.lockedStamp'), snapFont(Math.round(th * 0.44)), C.dark, true);
  label.anchor.set(0.5); label.alpha = 0.6;
  tape.addChild(label);
}

/** Rotated "Chapter N · Cleared" stamp near the chapter title. */
export function drawClearStamp(root: PIXI.Container, ch: number, x: number, y: number, h: number): void {
  const wrap = new PIXI.Container();
  const label = `${t('campaign.chapterLabel', { n: ch })} · ${t('campaign.chapterStamp')}`;
  const tx = txt(label, FS.heading, C.red, true);
  tx.anchor.set(0.5);
  const pad = Math.round(h * 0.012);
  const box = new PIXI.Graphics();
  new SketchPen(box, seedFor(x, y, ch)).rect(
    -tx.width / 2 - pad, -tx.height / 2 - pad / 2, tx.width + pad * 2, tx.height + pad, { color: C.red, width: 2.2 },
  );
  wrap.addChild(box); wrap.addChild(tx);
  wrap.x = x; wrap.y = y; wrap.rotation = -0.18; wrap.alpha = 0.85;
  root.addChild(wrap);
}
