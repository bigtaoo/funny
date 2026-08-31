// SettingsScene's rename + delete-account confirmation modals, extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛"). Both are pure draws given a narrow host —
// the open/close/submit state transitions stay on SettingsScene itself (they're small and drive
// bt/toast/render sequencing that doesn't belong in a "just draw" module).
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import { t } from '../../i18n';
import { ui as C, sketchPanel } from '../../render/sketchUi';
import { SketchPen } from '../../render/sketch';
import { caretDisplay } from '../../ui/inputDisplay';
import { FS, snapFont } from '../../render/fontScale';
import type { Hit } from '../../ui/hits';

function txt(label: string, size: number, color: number, bold = false): PIXI.Text {
  return makeText(label, {
    fontSize: size, fill: color, fontFamily: 'monospace',
    fontWeight: bold ? 'bold' : 'normal',
  });
}

/** What the two overlays below need out of SettingsScene. */
export interface OverlayHost {
  readonly container: PIXI.Container;
  readonly w: number;
  readonly h: number;
  readonly renameText: string;
  readonly caretOn: boolean;
  readonly hiddenInput: HTMLInputElement | null;
  hits: Hit[];
  submitRename(): void;
  closeRename(): void;
  submitDelete(): void;
  closeDelete(): void;
}

export function drawRenameOverlay(host: OverlayHost): void {
  const { w, h, container } = host;
  // Modal: discard the base-scene hits so only the overlay's controls are tappable.
  host.hits = [];

  const dim = new PIXI.Graphics();
  dim.beginFill(0x000000, 0.7); dim.drawRect(0, 0, w, h); dim.endFill();
  container.addChild(dim);

  const pw = Math.round(w * 0.72), ph = Math.round(h * 0.34);
  const px = (w - pw) / 2, py = (h - ph) / 2;
  const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, width: 2.4, seed: 33 });
  panel.x = px; panel.y = py;
  container.addChild(panel);

  const title = txt(t('settings.renameTitle'), FS.title, C.dark, true);
  title.anchor.set(0.5, 0); title.x = w / 2; title.y = py + Math.round(h * 0.03);
  container.addChild(title);

  // Input box.
  const ibX = px + Math.round(pw * 0.08), ibW = pw - 2 * Math.round(pw * 0.08);
  const ibY = py + Math.round(ph * 0.34), ibH = Math.round(h * 0.06);
  const ib = new PIXI.Graphics();
  ib.beginFill(0xffffff); ib.drawRect(ibX, ibY, ibW, ibH); ib.endFill();
  new SketchPen(ib, 34).rect(ibX + 2, ibY + 2, ibW - 4, ibH - 4, { color: C.accent, width: 2, jitter: 0.8 });
  container.addChild(ib);
  // Tapping the field (re)focuses the hidden input on touch devices.
  host.hits.push({ rect: { x: ibX, y: ibY, w: ibW, h: ibH }, fn: () => host.hiddenInput?.focus() });

  const display = caretDisplay(host.renameText, host.caretOn, t('settings.renamePlaceholder'));
  const field = txt(display, snapFont(Math.round(ibH * 0.42)), (host.renameText || host.caretOn) ? C.dark : C.mid);
  field.anchor.set(0, 0.5); field.x = ibX + Math.round(ibW * 0.04); field.y = ibY + ibH / 2;
  container.addChild(field);

  // Confirm / cancel.
  const btnW = Math.round(pw * 0.4), btnH = Math.round(h * 0.06);
  const byy = py + ph - btnH - Math.round(h * 0.03);
  const okX = px + Math.round(pw * 0.08), cancelX = px + pw - Math.round(pw * 0.08) - btnW;

  const okBox = new PIXI.Graphics();
  okBox.beginFill(C.green); okBox.drawRect(okX, byy, btnW, btnH); okBox.endFill();
  container.addChild(okBox);
  const okLbl = txt(t('settings.renameConfirm'), snapFont(Math.round(btnH * 0.36)), 0xffffff, true);
  okLbl.anchor.set(0.5, 0.5); okLbl.x = okX + btnW / 2; okLbl.y = byy + btnH / 2;
  container.addChild(okLbl);
  host.hits.push({ rect: { x: okX, y: byy, w: btnW, h: btnH }, fn: () => host.submitRename() });

  const cBox = new PIXI.Graphics();
  cBox.beginFill(C.mid); cBox.drawRect(cancelX, byy, btnW, btnH); cBox.endFill();
  container.addChild(cBox);
  const cLbl = txt(t('settings.renameCancel'), snapFont(Math.round(btnH * 0.36)), 0xffffff, true);
  cLbl.anchor.set(0.5, 0.5); cLbl.x = cancelX + btnW / 2; cLbl.y = byy + btnH / 2;
  container.addChild(cLbl);
  host.hits.push({ rect: { x: cancelX, y: byy, w: btnW, h: btnH }, fn: () => host.closeRename() });

  // Tap anywhere outside the panel/buttons closes the overlay — registered LAST so the
  // specific button hits above take priority (handleDown is first-match-wins).
  host.hits.push({ rect: { x: 0, y: 0, w, h }, fn: () => host.closeRename() });
}

export function drawDeleteConfirm(host: OverlayHost): void {
  const { w, h, container } = host;
  // Modal: discard base-scene hits so only the overlay's controls are tappable.
  host.hits = [];

  const dim = new PIXI.Graphics();
  dim.beginFill(0x000000, 0.7); dim.drawRect(0, 0, w, h); dim.endFill();
  container.addChild(dim);

  const pw = Math.round(w * 0.78), ph = Math.round(h * 0.36);
  const px = (w - pw) / 2, py = (h - ph) / 2;
  const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.red, width: 2.6, seed: 37 });
  panel.x = px; panel.y = py;
  container.addChild(panel);

  const title = txt(t('settings.deleteAccount.confirmTitle'), FS.title, C.red, true);
  title.anchor.set(0.5, 0); title.x = w / 2; title.y = py + Math.round(h * 0.03);
  container.addChild(title);

  const body = makeText(t('settings.deleteAccount.confirmBody'), {
    fontSize: FS.heading, fill: C.dark, fontFamily: 'monospace',
    wordWrap: true, wordWrapWidth: pw * 0.86, align: 'center', lineHeight: Math.round(h * 0.036),
  });
  body.anchor.set(0.5, 0); body.x = w / 2; body.y = py + Math.round(ph * 0.26);
  container.addChild(body);

  // Confirm (danger) / cancel.
  const btnW = Math.round(pw * 0.4), btnH = Math.round(h * 0.06);
  const byy = py + ph - btnH - Math.round(h * 0.03);
  const delX = px + Math.round(pw * 0.08), cancelX = px + pw - Math.round(pw * 0.08) - btnW;

  const delBox = new PIXI.Graphics();
  delBox.beginFill(C.red); delBox.drawRect(delX, byy, btnW, btnH); delBox.endFill();
  container.addChild(delBox);
  const delLbl = txt(t('settings.deleteAccount.confirm'), snapFont(Math.round(btnH * 0.32)), 0xffffff, true);
  delLbl.anchor.set(0.5, 0.5); delLbl.x = delX + btnW / 2; delLbl.y = byy + btnH / 2;
  container.addChild(delLbl);
  host.hits.push({ rect: { x: delX, y: byy, w: btnW, h: btnH }, fn: () => host.submitDelete() });

  const cBox = new PIXI.Graphics();
  cBox.beginFill(C.mid); cBox.drawRect(cancelX, byy, btnW, btnH); cBox.endFill();
  container.addChild(cBox);
  const cLbl = txt(t('settings.deleteAccount.cancel'), snapFont(Math.round(btnH * 0.36)), 0xffffff, true);
  cLbl.anchor.set(0.5, 0.5); cLbl.x = cancelX + btnW / 2; cLbl.y = byy + btnH / 2;
  container.addChild(cLbl);
  host.hits.push({ rect: { x: cancelX, y: byy, w: btnW, h: btnH }, fn: () => host.closeDelete() });

  // Tap outside panel = cancel (registered last so the buttons win — first-match-wins).
  host.hits.push({ rect: { x: 0, y: 0, w, h }, fn: () => host.closeDelete() });
}
