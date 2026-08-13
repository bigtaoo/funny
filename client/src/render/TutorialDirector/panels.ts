// TutorialDirector's one-time UI-layer construction + the shared instruction-panel drawer,
// extracted as form① free functions (claudedocs/client-modules.md "单文件 500 行收敛"). The
// phase-specific orchestration (renderOrientation/renderBeatPrompt/showBeatCollapse/renderFreePlay/
// animatePulse) stayed on TutorialDirector itself — those interleave host highlight calls with
// several phase fields in ways that would need a much larger ctx surface for comparatively little
// line-count benefit; this module covers the two genuinely self-contained pieces (build-once layer
// setup, and the repeatedly-redrawn instruction card).
//
// dim/slotRing/clusterRing/cardPanel are getter/setter pairs (not plain properties) because
// buildLayers assigns them wholesale (`this.dim = new PIXI.Graphics()`) — a plain copied property
// would only rebind this throwaway host object, never reaching back to TutorialDirector's own
// field (same reasoning as RoomScene/views.ts's RoomViewHost).
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../pixiText';
import { tearDownChildren } from '../sketchUi';
import { ILayout, Rect } from '../../layout/ILayout';
import { t, type TranslationKey } from '../../i18n';
import { drawHudButton, hudButtonText } from '../../ui/widgets/hudButton';
import { snapFont } from '../fontScale';
import type { Phase } from './types';

export interface PanelHost {
  readonly root: PIXI.Container;
  readonly layout: ILayout;
  readonly phase: Phase;
  dim: PIXI.Graphics;
  slotRing: PIXI.Graphics;
  clusterRing: PIXI.Graphics;
  cardPanel: PIXI.Container;
  skipBtnRect: Rect;
  nextBtnRect: Rect | null;
  actionBtnRect: Rect | null;
  onSkip(): void;
}

export function buildLayers(host: PanelHost): void {
  const { designWidth: W, designHeight: H } = host.layout;

  const dim = new PIXI.Graphics();
  dim.beginFill(0x000000, 0.55).drawRect(0, 0, W, H).endFill();
  dim.visible = false;
  host.root.addChild(dim);
  host.dim = dim;

  const slotRing = new PIXI.Graphics();
  slotRing.visible = false;
  host.root.addChild(slotRing);
  host.slotRing = slotRing;

  const clusterRing = new PIXI.Graphics();
  clusterRing.visible = false;
  host.root.addChild(clusterRing);
  host.clusterRing = clusterRing;

  const cardPanel = new PIXI.Container();
  host.root.addChild(cardPanel);
  host.cardPanel = cardPanel;

  // Persistent skip button (top-right).
  drawSkipButton(host);
}

function drawSkipButton(host: PanelHost): void {
  const { designWidth: W } = host.layout;
  const bw = Math.round(W * 0.18);
  const bh = Math.round(bw * 0.42);
  const bx = W - bw - Math.round(W * 0.03);
  const by = Math.round(bh * 0.6);
  host.skipBtnRect = { x: bx, y: by, w: bw, h: bh };
  const g = new PIXI.Graphics();
  drawHudButton(g, bw, bh, 'primary', { radius: bh * 0.3, fillAlpha: 0.78 });
  g.x = bx; g.y = by;
  host.root.addChild(g);
  const lbl = makeText(t('tutorial.skip' as TranslationKey), {
    fontFamily: 'monospace', fontSize: snapFont(Math.round(bh * 0.42)), fill: hudButtonText('primary'),
  });
  lbl.anchor.set(0.5);
  lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
  host.root.addChild(lbl);
}

/** Instruction card: centered at the bottom (phases B/C do not obscure the upper board), containing title + body + optional button. */
export function drawPanel(host: PanelHost, title: string, body: string, btnLabel: string | null, btnKind: 'next' | 'action' | 'beat'): void {
  clearPanel(host);
  const { designWidth: W, designHeight: H } = host.layout;
  const pw = Math.round(W * 0.86);
  const px = (W - pw) / 2;
  const hasBtn = !!btnLabel;
  const ph = Math.round(H * (hasBtn ? 0.22 : 0.15));
  // Phase B: card panel sits just above the hand area (below the board); orientation/free-play: centered toward the bottom.
  const py = host.phase === 'beat'
    ? Math.round(host.layout.handRect.y - ph - H * 0.02)
    : Math.round(H * 0.6);

  const bg = new PIXI.Graphics();
  bg.beginFill(0xf6efdd, 0.97);
  bg.lineStyle(2.4, 0x4a7fc1, 1);
  bg.drawRoundedRect(px, py, pw, ph, 12).endFill();
  host.cardPanel.addChild(bg);

  const titleLbl = makeText(title, {
    fontFamily: 'monospace', fontSize: snapFont(Math.round(ph * 0.18)), fontWeight: 'bold', fill: 0x2b2b2b,
    wordWrap: true, wordWrapWidth: pw - 32,
  });
  titleLbl.x = px + 16; titleLbl.y = py + 14;
  host.cardPanel.addChild(titleLbl);

  const bodyLbl = makeText(body, {
    fontFamily: 'monospace', fontSize: snapFont(Math.round(ph * 0.13)), fill: 0x6b6b6b,
    wordWrap: true, wordWrapWidth: pw - 32,
  });
  bodyLbl.x = px + 16; bodyLbl.y = py + 14 + Math.round(ph * 0.26);
  host.cardPanel.addChild(bodyLbl);

  host.nextBtnRect = null;
  host.actionBtnRect = null;
  if (hasBtn) {
    const bw = Math.round(pw * 0.32);
    const bh = Math.round(ph * 0.28);
    const bx = px + pw - bw - 16;
    const by = py + ph - bh - 14;
    const btn = new PIXI.Graphics();
    drawHudButton(btn, bw, bh, 'accent', { radius: bh * 0.3 });
    btn.x = bx; btn.y = by;
    host.cardPanel.addChild(btn);
    const bl = makeText(btnLabel!, {
      fontFamily: 'monospace', fontSize: snapFont(Math.round(bh * 0.46)), fontWeight: 'bold', fill: hudButtonText('accent'),
    });
    bl.anchor.set(0.5);
    bl.x = bx + bw / 2; bl.y = by + bh / 2;
    host.cardPanel.addChild(bl);
    const rect = { x: bx, y: by, w: bw, h: bh };
    if (btnKind === 'next') host.nextBtnRect = rect;
    else if (btnKind === 'action') host.actionBtnRect = rect;
  }
}

export function clearPanel(host: PanelHost): void {
  // tearDownChildren frees each Text's baseTexture (texture:true); the prior removeChildren().forEach(destroy)
  // used the default texture:false, orphaning the panel's makeText labels on every tutorial-beat advance.
  tearDownChildren(host.cardPanel);
  host.nextBtnRect = null;
  host.actionBtnRect = null;
}
