// Shared numeric-stepper widget (addNumInput) + its tap-to-type editor (openNumInput) — used by both
// bid.ts (bid amount) and create-listing.ts (qty/price/startPrice/buyout). Split out of core.ts during
// the 2026-08-11 composition conversion purely to bring core.ts back under the 500-line convention
// (see claudedocs/client-modules.md's split-form priority note) — this is the "chrome/header" free-
// function half of that split: both siblings that used to call these as inherited `this.xxx` methods
// now import them directly and pass `core` explicitly (`addNumInput(core, ...)`), mirroring
// FriendsScene/chrome.ts's addButton/scrollRegion convention. No delegation methods are left on Core.
import type * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { caretDisplay } from '../../ui/inputDisplay';
import type { AuctionSceneCore } from './core';

export function addNumInput(
  core: AuctionSceneCore,
  layer: PIXI.Container,
  mx: number, y: number,
  label: string,
  value: number,
  onChange: (v: number) => void,
  scale = 1,
  // When `editKey` is set the value becomes a tappable text field (type a number directly); `clamp`
  // (if given) is applied when the user commits the typed value on blur — used to snap out-of-range
  // prices back into the allowed band.
  opts?: { editKey?: string; clamp?: (v: number) => number },
): void {
  const btnSize = 24 * scale;
  const gap = 8 * scale;
  const half = btnSize / 2;

  const lbl = txt(label, snapFont(12 * scale), C.dark);
  lbl.x = mx + 10 * scale; lbl.y = y;
  layer.addChild(lbl);

  const minusBtn = sketchPanel(btnSize, btnSize, { fill: 0xeeeeee, border: C.mid, seed: seedFor(y, 0, btnSize) });
  minusBtn.x = mx + 10 * scale + lbl.width + gap; minusBtn.y = y - 2 * scale;
  layer.addChild(minusBtn);
  const ml = txt('−', snapFont(14 * scale), C.dark);
  ml.anchor.set(0.5, 0.5); ml.x = minusBtn.x + half; ml.y = y + 10 * scale;
  layer.addChild(ml);
  core.modalHits.push({ rect: { x: minusBtn.x, y: minusBtn.y, w: btnSize, h: btnSize }, action: () => onChange(value - 1) });

  const editing = opts?.editKey != null && core.numEditKey === opts.editKey;
  if (opts?.editKey != null) {
    // Editable field: tap to type a value directly (mirrors the buyer-id field pattern).
    const fieldW = 64 * scale;
    const fieldH = btnSize;
    const fieldX = minusBtn.x + btnSize + gap;
    const field = sketchPanel(fieldW, fieldH, { fill: 0xfaf9f5, border: editing ? C.accent : C.mid, seed: seedFor(y, 2, fieldW) });
    field.x = fieldX; field.y = y - 2 * scale;
    layer.addChild(field);
    const valLbl = txt(caretDisplay(String(value), editing && core.caretOn, String(value)), snapFont(13 * scale), C.dark);
    valLbl.anchor.set(0.5, 0.5); valLbl.x = fieldX + fieldW / 2; valLbl.y = y + 10 * scale;
    layer.addChild(valLbl);
    core.modalHits.push({ rect: { x: fieldX, y: field.y, w: fieldW, h: fieldH }, action: () => openNumInput(core, opts.editKey!, value, onChange, opts.clamp) });

    const plusBtn = sketchPanel(btnSize, btnSize, { fill: 0xeeeeee, border: C.mid, seed: seedFor(y, 1, btnSize) });
    plusBtn.x = fieldX + fieldW + gap; plusBtn.y = y - 2 * scale;
    layer.addChild(plusBtn);
    const pl = txt('+', snapFont(14 * scale), C.dark);
    pl.anchor.set(0.5, 0.5); pl.x = plusBtn.x + half; pl.y = y + 10 * scale;
    layer.addChild(pl);
    core.modalHits.push({ rect: { x: plusBtn.x, y: plusBtn.y, w: btnSize, h: btnSize }, action: () => onChange(value + 1) });
    return;
  }

  const valLbl = txt(String(value), snapFont(13 * scale), C.dark);
  valLbl.anchor.set(0, 0.5);
  valLbl.x = minusBtn.x + btnSize + gap; valLbl.y = y + 10 * scale;
  layer.addChild(valLbl);

  const plusBtn = sketchPanel(btnSize, btnSize, { fill: 0xeeeeee, border: C.mid, seed: seedFor(y, 1, btnSize) });
  plusBtn.x = minusBtn.x + btnSize + gap + valLbl.width + gap; plusBtn.y = y - 2 * scale;
  layer.addChild(plusBtn);
  const pl = txt('+', snapFont(14 * scale), C.dark);
  pl.anchor.set(0.5, 0.5); pl.x = plusBtn.x + half; pl.y = y + 10 * scale;
  layer.addChild(pl);
  core.modalHits.push({ rect: { x: plusBtn.x, y: plusBtn.y, w: btnSize, h: btnSize }, action: () => onChange(value + 1) });
}

// Hidden-input driver for a tappable numeric field: live-updates the value as digits are typed and, on
// blur, applies the optional clamp so an out-of-range price snaps to the nearest allowed bound.
export function openNumInput(
  core: AuctionSceneCore,
  key: string,
  current: number,
  onChange: (v: number) => void,
  clamp?: (v: number) => number,
): void {
  core.numEditKey = key;
  core.caretOn = true;
  core.caretTimer = 0;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.inputMode = 'numeric';
  inp.value = String(current);
  inp.maxLength = 12;
  inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
  document.body.appendChild(inp);
  inp.focus();
  inp.select();
  const parse = (): number => {
    const digits = inp.value.replace(/[^0-9]/g, '');
    return digits === '' ? 0 : parseInt(digits, 10);
  };
  inp.addEventListener('input', () => {
    const digits = inp.value.replace(/[^0-9]/g, '');
    if (inp.value !== digits) inp.value = digits;
    onChange(parse());
  });
  // Enter commits the value the same way blur does (PC keyboard convenience — mobile taps
  // elsewhere to blur, so this is additive, not a replacement path).
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  inp.addEventListener('blur', () => {
    const v = parse();
    core.numEditKey = null;
    inp.remove();
    if (core.hiddenInput === inp) core.hiddenInput = null;
    onChange(clamp ? clamp(v) : v);
  });
  core.hiddenInput = inp;
}
