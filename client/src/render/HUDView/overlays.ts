// HUDView's surrender-confirmation and game-over overlays, extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛"). surrenderOverlay/gameOverOverlay/
// surrenderCancelRect/surrenderConfirmRect are getter/setter pairs (not plain properties) because
// show/hideSurrenderConfirm reassign them wholesale — a plain copied property would only rebind
// this throwaway host object, never reaching back to HUDView's own field (same reasoning as
// RoomScene/views.ts's RoomViewHost).
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../pixiText';
import { getLabelTexture } from '../labelDecor';
import { drawHudButton, hudButtonText, type HudButtonVariant } from '../../ui/widgets/hudButton';
import { FS, snapFont } from '../fontScale';
import { ILayout, Rect } from '../../layout/ILayout';
import { t } from '../../i18n';
import type { OwnerId } from '@nw/engine/types';

export interface OverlayHost {
  readonly container: PIXI.Container;
  readonly layout: ILayout;
  readonly campaign: boolean;
  surrenderOverlay: PIXI.Container | null;
  gameOverOverlay: PIXI.Container | null;
  surrenderCancelRect: Rect | null;
  surrenderConfirmRect: Rect | null;
}

function makeBtn(
  x: number, y: number, w: number, h: number,
  variant: HudButtonVariant, label: string,
): PIXI.Container {
  const c = new PIXI.Container();
  const bg = new PIXI.Graphics();
  drawHudButton(bg, w, h, variant, { radius: 6 });
  const txt = makeText(label, {
    fontSize: snapFont(Math.round(h * 0.42)), fill: hudButtonText(variant), fontWeight: 'bold', fontFamily: 'monospace',
  });
  txt.anchor.set(0.5, 0.5);
  txt.x = w / 2; txt.y = h / 2;
  c.addChild(bg, txt);
  c.x = x; c.y = y;
  return c;
}

export function showSurrenderConfirm(host: OverlayHost): void {
  if (host.surrenderOverlay) return;
  const dw = host.layout.designWidth;
  const dh = host.layout.designHeight;
  const overlay = new PIXI.Container();

  const dim = new PIXI.Graphics();
  dim.beginFill(0x000000, 0.6);
  dim.drawRect(0, 0, dw, dh);
  dim.endFill();
  overlay.addChild(dim);

  const pW = Math.round(dw * 0.55);
  const pH = Math.round(dh * 0.30);
  const pX = (dw - pW) / 2;
  const pY = (dh - pH) / 2;

  const panel = new PIXI.Graphics();
  panel.beginFill(0xfaf6ee);
  panel.lineStyle(2, 0x333333);
  panel.drawRoundedRect(pX, pY, pW, pH, 8);
  panel.endFill();
  overlay.addChild(panel);

  const title = makeText(t(host.campaign ? 'hud.exitLevelTitle' : 'hud.surrenderTitle'), {
    fontSize: snapFont(Math.round(pH * 0.18)), fill: 0x222222,
    fontWeight: 'bold', fontFamily: 'monospace',
  });
  title.anchor.set(0.5, 0);
  title.x = dw / 2;
  title.y = pY + pH * 0.08;
  overlay.addChild(title);

  const bW = Math.round(pW * 0.72);
  const bH = Math.round(pH * 0.20);
  const gap = Math.round(pH * 0.06);
  const y1  = pY + pH * 0.38;
  const y2  = y1 + bH + gap;
  const bX  = (dw - bW) / 2;

  overlay.addChild(makeBtn(bX, y1, bW, bH, 'secondary', t('hud.surrenderCancel')));
  overlay.addChild(makeBtn(bX, y2, bW, bH, 'primary',   t(host.campaign ? 'hud.exitLevelConfirm' : 'hud.surrenderConfirm')));

  host.surrenderCancelRect  = { x: bX, y: y1, w: bW, h: bH };
  host.surrenderConfirmRect = { x: bX, y: y2, w: bW, h: bH };

  host.container.addChild(overlay);
  host.surrenderOverlay = overlay;
}

export function hideSurrenderConfirm(host: OverlayHost): void {
  if (!host.surrenderOverlay) return;
  host.container.removeChild(host.surrenderOverlay);
  host.surrenderOverlay.destroy({ children: true });
  host.surrenderOverlay     = null;
  host.surrenderCancelRect  = null;
  host.surrenderConfirmRect = null;
}

export function showGameOver(host: OverlayHost, winner: OwnerId | null, localOwner: OwnerId = 0): void {
  if (host.gameOverOverlay) return;
  const overlay = new PIXI.Container();
  const bg = new PIXI.Graphics();
  bg.beginFill(0x000000, 0.55);
  bg.drawRoundedRect(-160, -50, 320, 100, 8);
  bg.endFill();
  const msg  = winner === null ? t('hud.draw') : (winner === localOwner ? t('hud.win') : t('hud.lose'));
  const text = makeText(msg, { fontSize: FS.headline, fill: 0xffffff, fontWeight: 'bold' });
  text.anchor.set(0.5);
  overlay.addChild(bg, text);

  // Hand-drawn `WIN!` flourish above the box on a local victory (art-direction
  // §6.2 group B). Cosmetic — skipped silently if the label PNG hasn't loaded.
  if (winner === localOwner) {
    const winTex = getLabelTexture('label_win');
    if (winTex) {
      const win = new PIXI.Sprite(winTex);
      win.anchor.set(0.5);
      win.scale.set(Math.min(200 / winTex.width, 96 / winTex.height));
      win.rotation = -0.06;
      win.y = -50 - win.height / 2 - 12;
      overlay.addChild(win);
    }
  }
  overlay.x = host.layout.designWidth  / 2;
  overlay.y = host.layout.designHeight / 2;
  host.container.addChild(overlay);
  host.gameOverOverlay = overlay;
}
