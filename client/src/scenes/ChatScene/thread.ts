import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, marginLineX } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import type { ChatMessageView } from '../../net/ApiClient';

// ── Message-thread virtualization + bubble drawing for ChatScene ─────────────
//
// Extracted from the scene class (form① independent module, client-modules.md's split-priority
// convention) so ChatScene.ts stays under the 500-line convention, and because the measure/build
// split below is easiest to keep correct as pure functions with no `this.` state.
//
// Why this exists (2026-08-12 sweep, same bug class as BattlePassScene/LeaderboardScene):
// drawThread() used to build every message in `this.messages` into a real bubble (a Graphics
// panel + word-wrapped Text, sometimes +1 more Text) unconditionally, then only *position* the
// built set against the scroll mask afterward — the mask hides pixels, it does not stop object/
// texture creation. Unlike the battle pass's fixed 30 levels, chat history is genuinely
// unbounded: `loadEarlier()` prepends another PAGE(30) messages every time the user pages
// back through history, with no eviction, so the per-render object count grows without bound
// the longer a conversation gets paged through. Worse, render() (and thus this unconditional
// full build) re-runs on every scroll-drag frame AND every ~0.5s caret blink while composing —
// not just once on open. Mobile WebViews (iOS Safari in particular) treat many textures created
// synchronously in one frame as a memory spike and kill/reload the whole tab.
//
// Fix: a cheap measure pass (measureRows, below) computes every row's content-space y + height
// using PIXI.TextMetrics — which measures word-wrap layout without rasterizing a canvas texture,
// unlike actually constructing a PIXI.Text — so the total content height (needed for
// maxScroll/stickBottom) is known before touching the GPU at all. Only rows within the caller's
// visible band then get built into real PIXI DisplayObjects via buildBubble(). Since ChatScene
// already tears down and rebuilds its whole container on every render() (it never grew the
// reposition-only fast path BattlePassScene/LeaderboardScene did — see their history), this
// measure+cull split alone is enough: there's no cross-render cache to maintain.

export type RowKind = 'loadEarlier' | 'empty' | 'bubble';

/** One thread row's content-space geometry, computed by measureRows() without building any
 *  PIXI DisplayObject — cheap enough to run over the *entire* (unbounded) message list. */
export interface ThreadRow {
  cy: number;
  h: number;
  kind: RowKind;
  msg?: ChatMessageView;
  /** loadEarlier only — tap-target height (may differ from the label's own line height). */
  hitH?: number;
}

const BUBBLE_MAX_W_FRAC = 0.68;
const BUBBLE_PAD_X_FRAC = 0.03;
const BUBBLE_PAD_Y_FRAC = 0.012;
const FAIL_CAP_GAP_FRAC = 0.004;
const FAIL_FONT_FRAC = 0.018;

/** Word-wrapped body height for a bubble of the given content width, via TextMetrics — no
 *  PIXI.Text/canvas texture created (see pixiText.ts: padding, which makeText() adds on top,
 *  is deliberately excluded from affecting reported width/height, so this stays exactly
 *  consistent with the real Text buildBubble() later constructs for on-screen rows). */
function measureBodyHeight(body: string, contentW: number): number {
  const style = new PIXI.TextStyle({
    fontSize: FS.heading, fontFamily: 'monospace', wordWrap: true, wordWrapWidth: contentW, breakWords: true,
  });
  return Math.ceil(PIXI.TextMetrics.measureText(body, style).height);
}

function measureFailLabelHeight(h: number): number {
  const style = new PIXI.TextStyle({ fontSize: snapFont(Math.round(h * FAIL_FONT_FRAC)), fontFamily: 'monospace', fontWeight: 'bold' });
  return Math.ceil(PIXI.TextMetrics.measureText(t('chat.sendFailed'), style).height);
}

/** Mirrors buildBubble()'s height math exactly (same fractions/padding), just without building
 *  the Text/Graphics — see measureBodyHeight's doc for why that's safe to keep in sync. */
function measureBubbleHeight(m: ChatMessageView, w: number, h: number, failed: boolean): number {
  const maxW = Math.round(w * BUBBLE_MAX_W_FRAC);
  const padX = Math.round(w * BUBBLE_PAD_X_FRAC);
  const padY = Math.round(h * BUBBLE_PAD_Y_FRAC);
  const bh = measureBodyHeight(m.body, maxW - padX * 2) + padY * 2;
  if (!failed) return bh;
  return bh + Math.round(h * FAIL_CAP_GAP_FRAC) + measureFailLabelHeight(h);
}

/**
 * Cheap measure pass over the *entire* message list (however large): computes each row's
 * content-space top (`cy`) and height, plus the total content height. No GPU objects created.
 */
export function measureRows(
  messages: ChatMessageView[],
  hasMore: boolean,
  failedMessageIds: ReadonlySet<string>,
  w: number, h: number,
): { rows: ThreadRow[]; totalH: number } {
  const rows: ThreadRow[] = [];
  let cy = Math.round(h * 0.012);

  if (hasMore) {
    const hitH = Math.round(h * 0.04);
    rows.push({ cy, h: hitH, kind: 'loadEarlier', hitH });
    cy += Math.round(h * 0.05);
  }

  if (messages.length === 0) {
    rows.push({ cy: cy + Math.round(h * 0.04), h: Math.round(h * 0.05), kind: 'empty' });
    cy += Math.round(h * 0.1);
  } else {
    for (const m of messages) {
      const failed = failedMessageIds.has(m.messageId);
      const rowH = measureBubbleHeight(m, w, h, failed);
      rows.push({ cy, h: rowH, kind: 'bubble', msg: m });
      cy += rowH + Math.round(h * 0.012);
    }
  }

  return { rows, totalH: cy };
}

/** Build a message bubble container; returns it + its height (positioned by the caller). */
export function buildBubble(
  m: ChatMessageView, w: number, h: number, myPublicId: string, failed: boolean,
): { node: PIXI.Container; height: number } {
  const mine = m.fromPublicId === myPublicId;
  const maxW = Math.round(w * BUBBLE_MAX_W_FRAC);
  const padX = Math.round(w * BUBBLE_PAD_X_FRAC);
  const padY = Math.round(h * BUBBLE_PAD_Y_FRAC);
  const body = makeText(m.body, {
    fontSize: FS.heading, fill: mine ? 0xffffff : C.dark,
    fontFamily: 'monospace', wordWrap: true, wordWrapWidth: maxW - padX * 2, breakWords: true,
  });
  const bw = Math.min(maxW, Math.ceil(body.width) + padX * 2);
  const bh = Math.ceil(body.height) + padY * 2;
  // Peer bubbles left-align just right of the red binding line so no content spills into the
  // notebook margin; mine right-align near the right edge.
  const leftEdge = marginLineX(w) + Math.round(w * 0.02);
  const bx = mine ? w - Math.round(w * 0.04) - bw : leftEdge;
  const node = new PIXI.Container();
  node.x = bx;
  const bg = sketchPanel(bw, bh, {
    fill: mine ? C.accent : C.paper, border: mine ? C.accent : C.line, width: 2,
    seed: seedFor(bx, Math.round(m.ts % 9973), bw),
  });
  node.addChild(bg);
  body.x = padX; body.y = padY;
  node.addChild(body);
  let height = bh;
  if (failed) {
    // Dim the bubble + caption it "Not delivered" instead of leaving a failed send looking exactly
    // like a normally delivered message (2026-08-03 fix).
    bg.alpha = 0.55;
    body.alpha = 0.55;
    const capGap = Math.round(h * FAIL_CAP_GAP_FRAC);
    const failLbl = txt(t('chat.sendFailed'), snapFont(Math.round(h * FAIL_FONT_FRAC)), 0xaa2222, true);
    failLbl.anchor.set(1, 0);
    failLbl.x = bw; failLbl.y = bh + capGap;
    node.addChild(failLbl);
    height = bh + capGap + Math.ceil(failLbl.height);
  }
  return { node, height };
}
