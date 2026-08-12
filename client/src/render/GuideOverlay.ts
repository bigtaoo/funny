// GuideOverlay — lightweight, reusable "spotlight" widget for first-time UI guidance
// (ONBOARDING_DESIGN §4.2, SLG opening guide chain). Draws a breathing highlight ring around a
// target rect plus a small dismissible bubble (auto-placed above/below, clamped on-screen), or a
// target-less bottom card for tips that have no fixed on-screen anchor (e.g. "occupy nearby land").
//
// Deliberately NOT a port of TutorialDirector (render/TutorialDirector.ts): that class is battle-
// tutorial-specific (couples to GameState/BEATS/hand-slot geometry) and swallows all input while
// active. This widget never intercepts input — it is a pure visual hint; the host scene's own click
// dispatch keeps working underneath (ONBOARDING_DESIGN §4.1: "轻提示…不阻断玩家用功能"). The one
// piece of input it does need — tapping its own skip glyph / card button — is exposed via
// `currentAction()` so the host can splice it into whatever hit-test mechanism it already has
// (WorldMapInput's manual dispatch, CitySceneCore's `hits` list), rather than this widget owning
// its own InputManager subscription.
//
// Usage is idempotent by design: call `showAt`/`showCard` every render pass with the flags-derived
// decision for "what should be showing right now" — a repeat call with the same text is a cheap
// no-op (only the ring's breathing phase redraws via `update`); a call with different text/target
// rebuilds the bubble. Callers therefore never need to reason about "did I already call hide()".
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, tearDownChildren } from './sketchUi';
import { FS } from './fontScale';
import { drawHudButton, hudButtonText } from '../ui/widgets/hudButton';

export interface GuideRect { x: number; y: number; w: number; h: number; }
export interface GuideViewport { w: number; h: number; }

const RING_PAD = 10;
const BUBBLE_GAP = 10;
const BUBBLE_PAD = 12;
const BUBBLE_MAX_W = 320;
const SKIP_SIZE = 22;

export class GuideOverlay {
  /** Root container — caller `addChild`s this wherever/whenever it needs to sit on top (this class
   * never attaches itself: some hosts, e.g. CityScene, rebuild their main content container from
   * scratch on every render() and need the guide layer attached to a separate, never-torn-down
   * sibling *after* that content — see CityScene.ts's constructor). */
  readonly root: PIXI.Container;
  private readonly ring: PIXI.Graphics;
  private bubble: PIXI.Container | null = null;

  private activeKey: string | null = null;
  private targetRect: GuideRect | null = null;
  private pulseT = 0;

  /** Current tappable action (skip glyph on a spotlight bubble, or the button on a card) — null when nothing is showing. Rect is in the same coordinate space as wherever the host mounted `root` (scene-absolute screen px, as long as that ancestry carries no transform — true for every current host). */
  private action: { rect: GuideRect; fn: () => void } | null = null;

  constructor() {
    this.root = new PIXI.Container();
    this.ring = new PIXI.Graphics();
    this.ring.visible = false;
    this.root.addChild(this.ring);
  }

  /** The tappable rect + trigger for whatever is currently showing (skip glyph / card button), or null if nothing is active. Host splices this into its own hit-test. */
  currentAction(): { rect: GuideRect; fn: () => void } | null {
    return this.action;
  }

  /**
   * Highlight `rect` with a breathing ring + a small text bubble (auto above/below, clamped inside
   * `viewport`). Re-calling with the same `text` on a moved `rect` (e.g. following pan/zoom) only
   * repositions — cheap, safe to call every frame/render.
   */
  showAt(rect: GuideRect, text: string, viewport: GuideViewport, opts?: { onSkip?: () => void }): void {
    this.targetRect = rect;
    this.ring.visible = true;
    const key = `at:${text}`;
    if (this.activeKey === key) {
      this.positionBubble(rect, viewport);
      this.drawRing(rect);
      return;
    }
    this.activeKey = key;
    this.buildBubble(text, viewport, opts?.onSkip);
    this.positionBubble(rect, viewport);
    this.drawRing(rect);
  }

  /**
   * Target-less tip card, bottom-anchored, with a labeled dismiss button instead of a corner skip
   * glyph (used when there is no fixed on-screen target — e.g. "click empty land near your base").
   */
  showCard(text: string, btnLabel: string, onBtn: () => void, viewport: GuideViewport): void {
    this.targetRect = null;
    this.ring.visible = false;
    const key = `card:${text}`;
    if (this.activeKey === key) return; // already showing this exact card — no-op
    this.activeKey = key;
    this.buildCard(text, btnLabel, onBtn, viewport);
  }

  /** Advance the ring's breathing animation. Call every frame while mounted; cheap no-op when nothing is active. */
  update(dt: number): void {
    this.pulseT += dt;
    if (this.ring.visible && this.targetRect) this.drawRing(this.targetRect);
  }

  /** Clear whatever is currently showing. Root stays mounted for reuse. */
  hide(): void {
    this.activeKey = null;
    this.targetRect = null;
    this.action = null;
    this.ring.visible = false;
    if (this.bubble) { tearDownChildren(this.bubble); this.bubble.destroy(); this.bubble = null; }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private drawRing(rect: GuideRect): void {
    const a = 0.5 + 0.4 * (0.5 + 0.5 * Math.sin(this.pulseT * 4));
    const x = rect.x - RING_PAD;
    const y = rect.y - RING_PAD;
    const w = rect.w + RING_PAD * 2;
    const h = rect.h + RING_PAD * 2;
    this.ring.clear();
    this.ring.lineStyle(3.5, C.accent, a);
    this.ring.drawRoundedRect(x, y, w, h, 10);
  }

  private buildBubble(text: string, viewport: GuideViewport, onSkip?: () => void): void {
    if (this.bubble) { tearDownChildren(this.bubble); this.bubble.destroy(); }
    const bubble = new PIXI.Container();
    this.bubble = bubble;
    this.root.addChild(bubble);

    const bw = Math.min(BUBBLE_MAX_W, viewport.w - 24);
    const bodyLbl = txt(text, FS.body, C.dark, false, bw - BUBBLE_PAD * 2 - (onSkip ? SKIP_SIZE : 0));
    const bh = Math.max(48, bodyLbl.height + BUBBLE_PAD * 2);

    const bg = new PIXI.Graphics();
    bg.beginFill(C.paper, 0.98);
    bg.lineStyle(2, C.accent, 1);
    bg.drawRoundedRect(0, 0, bw, bh, 10);
    bg.endFill();
    bubble.addChild(bg);

    bodyLbl.x = BUBBLE_PAD;
    bodyLbl.y = Math.round((bh - bodyLbl.height) / 2);
    bubble.addChild(bodyLbl);

    if (onSkip) {
      const sx = bw - SKIP_SIZE - 4;
      const sy = 4;
      const skipLbl = txt('×', FS.bodyLg, C.mid, true);
      skipLbl.x = sx + (SKIP_SIZE - skipLbl.width) / 2;
      skipLbl.y = sy + (SKIP_SIZE - skipLbl.height) / 2;
      bubble.addChild(skipLbl);
      // Rect stashed relative to the bubble; positionBubble() below stores the absolute action rect
      // (bubble.x/y are only known once positioned, which happens right after this call in showAt).
      this._pendingSkipLocalRect = { x: sx, y: sy, w: SKIP_SIZE, h: SKIP_SIZE };
      this._pendingSkipFn = onSkip;
    } else {
      this._pendingSkipLocalRect = null;
      this._pendingSkipFn = null;
    }
    this._bubbleW = bw;
    this._bubbleH = bh;
  }

  private _bubbleW = 0;
  private _bubbleH = 0;
  private _pendingSkipLocalRect: GuideRect | null = null;
  private _pendingSkipFn: (() => void) | null = null;

  /** Places the bubble above or below `rect` (whichever has more room), clamped horizontally within `viewport`. */
  private positionBubble(rect: GuideRect, viewport: GuideViewport): void {
    if (!this.bubble) return;
    const bw = this._bubbleW;
    const bh = this._bubbleH;
    const spaceAbove = rect.y;
    const spaceBelow = viewport.h - (rect.y + rect.h);
    const above = spaceAbove >= bh + BUBBLE_GAP || spaceAbove > spaceBelow;
    const by = above ? rect.y - BUBBLE_GAP - bh : rect.y + rect.h + BUBBLE_GAP;
    let bx = rect.x + rect.w / 2 - bw / 2;
    bx = Math.max(8, Math.min(viewport.w - bw - 8, bx));
    this.bubble.x = bx;
    this.bubble.y = Math.max(8, Math.min(viewport.h - bh - 8, by));

    this.action = this._pendingSkipFn && this._pendingSkipLocalRect
      ? {
          rect: {
            x: this.bubble.x + this._pendingSkipLocalRect.x,
            y: this.bubble.y + this._pendingSkipLocalRect.y,
            w: this._pendingSkipLocalRect.w,
            h: this._pendingSkipLocalRect.h,
          },
          fn: this._pendingSkipFn,
        }
      : null;
  }

  private buildCard(text: string, btnLabel: string, onBtn: () => void, viewport: GuideViewport): void {
    if (this.bubble) { tearDownChildren(this.bubble); this.bubble.destroy(); }
    const bubble = new PIXI.Container();
    this.bubble = bubble;
    this.root.addChild(bubble);

    const bw = Math.min(BUBBLE_MAX_W + 40, viewport.w - 24);
    const btnW = 96;
    const bodyLbl = txt(text, FS.body, C.dark, false, bw - BUBBLE_PAD * 2 - btnW - 8);
    const bh = Math.max(56, bodyLbl.height + BUBBLE_PAD * 2);

    const bg = new PIXI.Graphics();
    bg.beginFill(C.paper, 0.98);
    bg.lineStyle(2, C.accent, 1);
    bg.drawRoundedRect(0, 0, bw, bh, 10);
    bg.endFill();
    bubble.addChild(bg);

    bodyLbl.x = BUBBLE_PAD;
    bodyLbl.y = Math.round((bh - bodyLbl.height) / 2);
    bubble.addChild(bodyLbl);

    const btnH = Math.min(40, bh - 16);
    const btnX = bw - btnW - BUBBLE_PAD;
    const btnY = Math.round((bh - btnH) / 2);
    const btnG = new PIXI.Graphics();
    drawHudButton(btnG, btnW, btnH, 'accent', { radius: btnH * 0.3 });
    btnG.x = btnX; btnG.y = btnY;
    bubble.addChild(btnG);
    const btnLbl = txt(btnLabel, FS.body, hudButtonText('accent'), true);
    btnLbl.x = btnX + (btnW - btnLbl.width) / 2;
    btnLbl.y = btnY + (btnH - btnLbl.height) / 2;
    bubble.addChild(btnLbl);

    bubble.x = Math.round((viewport.w - bw) / 2);
    bubble.y = viewport.h - bh - 24;

    this.action = { rect: { x: bubble.x + btnX, y: bubble.y + btnY, w: btnW, h: btnH }, fn: onBtn };
  }
}
