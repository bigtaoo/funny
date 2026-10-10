// TutorialDirector's one-time UI-layer construction + the redrawn instruction strip / graduation card,
// extracted as form① free functions (claudedocs/client-modules.md "单文件 500 行收敛"). The per-frame
// orchestration (beat state machine, ghost-hand animation, rings) stays on TutorialDirector itself.
//
// slotRing/clusterRing/strip/... are getter/setter pairs on the host (not plain properties) because
// buildLayers assigns them wholesale — a plain copied property would only rebind the throwaway host
// object, never reaching back to TutorialDirector's own field (same reasoning as RoomScene/views.ts).
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../pixiText';
import { tearDownChildren } from '../sketchUi';
import { ILayout, Rect } from '../../layout/ILayout';
import { t, type TranslationKey } from '../../i18n';
import { drawHudButton, hudButtonText } from '../../ui/widgets/hudButton';
import { fitFont, FS } from '../fontScale';
import { currentDesignScale } from '../bake';
import { UI_FONT_FAMILY } from '../theme';

export interface PanelHost {
  readonly root: PIXI.Container;
  readonly layout: ILayout;
  slotRing: PIXI.Graphics;
  clusterRing: PIXI.Graphics;
  /** Base labels (`YOU` / `ENEMY`), faded out by the director after the opening. */
  baseLabels: PIXI.Container;
  /** Ghost-hand demo layer (card ghost + fingertip), animated by the director. */
  ghost: PIXI.Container;
  /** The one-line instruction strip. */
  strip: PIXI.Container;
  /** Graduation card (message + optional reward line + button). */
  gradCard: PIXI.Container;
  skipBtn: PIXI.Container;
  skipBtnRect: Rect;
  ctaRect: Rect | null;
}

const C_BLUE = 0x4a7fc1;
const C_RED = 0xc0392b;
const C_PAPER = 0xf6efdd;
const C_INK = 0x2b2b2b;
const C_INK_SOFT = 0x5a5550;

/**
 * Smallest design-px font that still renders at `cssPx` on screen (ONBOARDING_DESIGN §11.5: instruction
 * text ≥ 14 CSS px). The FS table's own floor stops well below that on a phone (fontScale.ts header),
 * so the tutorial lifts its few lines itself.
 */
function legible(cssPx: number, designPx: number): number {
  const scale = currentDesignScale();
  return Math.max(designPx, Math.ceil(cssPx / (scale > 0 ? scale : 1)));
}

export function buildLayers(host: PanelHost): void {
  const slotRing = new PIXI.Graphics();
  slotRing.visible = false;
  host.root.addChild(slotRing);
  host.slotRing = slotRing;

  const clusterRing = new PIXI.Graphics();
  clusterRing.visible = false;
  host.root.addChild(clusterRing);
  host.clusterRing = clusterRing;

  const baseLabels = new PIXI.Container();
  host.root.addChild(baseLabels);
  host.baseLabels = baseLabels;
  drawBaseLabels(host);

  const strip = new PIXI.Container();
  host.root.addChild(strip);
  host.strip = strip;

  const ghost = new PIXI.Container();
  ghost.visible = false;
  host.root.addChild(ghost);
  host.ghost = ghost;

  drawSkipButton(host);

  const gradCard = new PIXI.Container();
  gradCard.visible = false;
  host.root.addChild(gradCard);
  host.gradCard = gradCard;
}

/** `YOU` over the player's base, `ENEMY` over theirs — replaces the old O1–O3 explanation cards. */
function drawBaseLabels(host: PanelHost): void {
  const L = host.layout;
  const fontSize = legible(16, FS.label);
  const put = (rect: Rect, text: string, color: number): void => {
    const lbl = makeText(text, { fontFamily: UI_FONT_FAMILY, fontSize, fontWeight: 'bold', fill: 0xffffff });
    lbl.anchor.set(0.5);
    const padX = Math.round(fontSize * 0.6);
    const padY = Math.round(fontSize * 0.25);
    const w = Math.ceil(lbl.width) + padX * 2;
    const h = Math.ceil(lbl.height) + padY * 2;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const bg = new PIXI.Graphics();
    bg.beginFill(color, 0.92).drawRoundedRect(cx - w / 2, cy - h / 2, w, h, h / 2).endFill();
    lbl.x = cx; lbl.y = cy;
    host.baseLabels.addChild(bg, lbl);
  };
  put(L.playerBaseRect(), t('tutorial.you'), C_BLUE);
  put(L.enemyBaseRect(), t('tutorial.enemy'), C_RED);
}

function drawSkipButton(host: PanelHost): void {
  const { designWidth: W } = host.layout;
  // Sized from its own text, not from the canvas: the old 18%-of-width pill was the largest thing on a
  // landscape screen and sat over the board (§11.5 — Skip must stay out of the way of every target).
  // The label still has to stay legible, and the pill is capped so a long translation shrinks instead.
  const fontSize = legible(13, FS.small);
  const bh = Math.round(fontSize * 2);
  const pad = Math.round(bh * 0.4);
  const maxW = Math.round(W * 0.34);
  const lbl = makeText(t('tutorial.skip' as TranslationKey), {
    fontFamily: UI_FONT_FAMILY, fontSize, fill: hudButtonText('primary'),
  });
  if (lbl.width + pad * 2 > maxW) {
    lbl.style.fontSize = fitFont(Number(lbl.style.fontSize), lbl.width, maxW - pad * 2);
  }
  const bw = Math.ceil(lbl.width) + pad * 2;
  const margin = Math.round(host.layout.cellSize * 0.3);
  const bx = W - bw - margin;
  const by = margin;
  host.skipBtnRect = { x: bx, y: by, w: bw, h: bh };
  const btn = new PIXI.Container();
  const g = new PIXI.Graphics();
  drawHudButton(g, bw, bh, 'primary', { radius: bh * 0.3, fillAlpha: 0.7 });
  g.x = bx; g.y = by;
  lbl.anchor.set(0.5);
  lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
  btn.addChild(g, lbl);
  host.root.addChild(btn);
  host.skipBtn = btn;
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The single instruction line (ONBOARDING_DESIGN §11.2 rule 3 / §11.5): a bold title and/or a short
 * body on one paper strip, placed in whichever band — top of the board or just above the hand —
 * covers less of `avoid` (target cells, the guided card, the meteor ring, the Skip button). Returns
 * the strip's rect.
 */
export function drawStrip(host: Pick<PanelHost, 'layout' | 'strip'>, title: string | null, body: string | null, avoid: readonly Rect[]): Rect {
  clearStrip(host);
  const L = host.layout;
  const W = L.designWidth;
  const pw = Math.round(Math.min(W * 0.9, Math.max(W * 0.6, L.boardRect.w)));
  const px = Math.round((W - pw) / 2);
  const padX = Math.round(legible(12, 16));
  const padY = Math.round(legible(8, 10));
  const titleSize = legible(18, FS.title);
  const bodySize = legible(14, FS.body);

  const parts: PIXI.Text[] = [];
  if (title) {
    parts.push(makeText(title, {
      fontFamily: UI_FONT_FAMILY, fontSize: titleSize, fontWeight: 'bold', fill: C_INK,
      wordWrap: true, wordWrapWidth: pw - padX * 2, align: 'center',
    }));
  }
  if (body) {
    parts.push(makeText(body, {
      fontFamily: UI_FONT_FAMILY, fontSize: bodySize, fill: C_INK,
      wordWrap: true, wordWrapWidth: pw - padX * 2, align: 'center',
    }));
  }
  const gap = Math.round(bodySize * 0.25);
  const contentH = parts.reduce((h, p) => h + p.height, 0) + gap * Math.max(0, parts.length - 1);
  const ph = Math.ceil(contentH + padY * 2);

  const margin = Math.round(L.cellSize * 0.25);
  const topY = Math.round(L.boardRect.y + margin);
  const bottomY = Math.round(L.handRect.y - ph - margin);
  const candidates = [bottomY, topY].map((y) => ({ x: px, y, w: pw, h: ph }));
  let best = candidates[0]!;
  let bestCost = Infinity;
  for (const c of candidates) {
    const cost = avoid.reduce((s, r) => s + overlapArea(c, r), 0);
    if (cost < bestCost) { best = c; bestCost = cost; }
  }

  const bg = new PIXI.Graphics();
  bg.beginFill(C_PAPER, 0.96);
  bg.lineStyle(2.4, C_BLUE, 1);
  bg.drawRoundedRect(best.x, best.y, best.w, best.h, Math.min(16, ph / 3)).endFill();
  host.strip.addChild(bg);
  let y = best.y + padY;
  for (const p of parts) {
    p.anchor.set(0.5, 0);
    p.x = best.x + best.w / 2;
    p.y = y;
    y += p.height + gap;
    host.strip.addChild(p);
  }
  host.strip.alpha = 1;
  host.strip.visible = true;
  return best;
}

export function clearStrip(host: Pick<PanelHost, 'strip'>): void {
  // tearDownChildren frees each Text's baseTexture (texture:true) — the strip is redrawn every beat.
  tearDownChildren(host.strip);
}

/**
 * Graduation card under the HUD's WIN banner (ONBOARDING_DESIGN §11.6): the one-line goal, an
 * optional reward line, the single button that leaves the tutorial, and optional small print under
 * it (the analytics notice, COMPLIANCE_GLOBAL §3.3b).
 */
export function drawGradCard(
  host: PanelHost, body: string, teaser: string | undefined, cta: string, footnote?: string,
): void {
  tearDownChildren(host.gradCard);
  const L = host.layout;
  const W = L.designWidth;
  const H = L.designHeight;
  const pw = Math.round(Math.min(W * 0.86, legible(360, 0)));
  const bodySize = legible(16, FS.bodyLg);
  const teaserSize = legible(15, FS.body);
  const btnSize = legible(17, FS.label);
  const pad = Math.round(bodySize * 0.8);

  const bodyLbl = makeText(body, {
    fontFamily: UI_FONT_FAMILY, fontSize: bodySize, fontWeight: 'bold', fill: C_INK,
    wordWrap: true, wordWrapWidth: pw - pad * 2, align: 'center',
  });
  const teaserLbl = teaser
    ? makeText(teaser, { fontFamily: UI_FONT_FAMILY, fontSize: teaserSize, fontWeight: 'bold', fill: 0xb7791f, align: 'center' })
    : null;
  const btnLbl = makeText(cta, { fontFamily: UI_FONT_FAMILY, fontSize: btnSize, fontWeight: 'bold', fill: hudButtonText('accent') });
  const bh = Math.ceil(btnLbl.height * 1.9);
  const bw = Math.min(pw - pad * 2, Math.ceil(btnLbl.width + bh * 1.2));
  // Small print, but still ≥ 14 CSS px (§11.5): a notice nobody can read is not a notice.
  const noteLbl = footnote
    ? makeText(footnote, {
      fontFamily: UI_FONT_FAMILY, fontSize: legible(14, FS.small), fill: C_INK_SOFT,
      wordWrap: true, wordWrapWidth: pw - pad * 2, align: 'center',
    })
    : null;

  const gap = Math.round(bodySize * 0.6);
  const ph = Math.ceil(pad + bodyLbl.height + gap + (teaserLbl ? teaserLbl.height + gap : 0) + bh
    + (noteLbl ? gap + noteLbl.height : 0) + pad);
  const px = Math.round((W - pw) / 2);
  // The HUD banner sits on the vertical centre (HUDView/overlays showGameOver: a 100-tall box);
  // the card hangs just below it.
  const py = Math.round(Math.min(H / 2 + 70, H - ph - L.cellSize * 0.5));

  const bg = new PIXI.Graphics();
  bg.beginFill(C_PAPER, 0.97);
  bg.lineStyle(2.4, C_BLUE, 1);
  bg.drawRoundedRect(px, py, pw, ph, 14).endFill();
  host.gradCard.addChild(bg);

  let y = py + pad;
  bodyLbl.anchor.set(0.5, 0); bodyLbl.x = W / 2; bodyLbl.y = y;
  host.gradCard.addChild(bodyLbl);
  y += bodyLbl.height + gap;
  if (teaserLbl) {
    teaserLbl.anchor.set(0.5, 0); teaserLbl.x = W / 2; teaserLbl.y = y;
    host.gradCard.addChild(teaserLbl);
    y += teaserLbl.height + gap;
  }
  const bx = Math.round(W / 2 - bw / 2);
  const btn = new PIXI.Graphics();
  drawHudButton(btn, bw, bh, 'accent', { radius: bh * 0.3 });
  btn.x = bx; btn.y = y;
  host.gradCard.addChild(btn);
  btnLbl.anchor.set(0.5);
  btnLbl.x = W / 2; btnLbl.y = y + bh / 2;
  host.gradCard.addChild(btnLbl);
  host.ctaRect = { x: bx, y, w: bw, h: bh };
  if (noteLbl) {
    noteLbl.anchor.set(0.5, 0); noteLbl.x = W / 2; noteLbl.y = y + bh + gap;
    host.gradCard.addChild(noteLbl);
  }

  // Pop in around the card's own centre.
  host.gradCard.pivot.set(W / 2, py + ph / 2);
  host.gradCard.position.set(W / 2, py + ph / 2);
  host.gradCard.visible = true;
}
