// ui/widgets/buttonLabel.ts — the shared `[icon][gap][label]` group every scene's button now draws
// its contents with. Three behaviours are worth a guard, because each one silently produces a
// PLAUSIBLE-looking button when it breaks:
//
//   1. no icon → one centred label, byte-for-byte what the scenes did before this widget existed;
//   2. icon → the GROUP is centred (regressing to "label centred" leaves the glyph hanging off the
//      left edge, which reads as a layout bug only if you happen to look at that button);
//   3. a button too narrow for both → the glyph is DROPPED and the label keeps its full size. This
//      is the whole reason "put an icon on every button" is safe to apply blindly: the friends list's
//      Accept/Decline pills are sized for two CJK characters, and scaling the group to fit there
//      would shrink the text past legibility rather than admit the icon doesn't fit.
//
// Geometry only — the icon texture never decodes headless, so this asserts positions (which
// drawButtonLabel sets from the font size, not from the texture) and child counts, never pixels.
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { drawButtonLabel, buttonLabelIconW } from '../../src/ui/widgets/buttonLabel';
import { initI18n } from '../../src/i18n';

initI18n('en');

const FS = 20;
const COLOR = 0xffffff;

function texts(root: PIXI.Container): PIXI.Text[] {
  return root.children.filter((c): c is PIXI.Text => c instanceof PIXI.Text);
}

describe('drawButtonLabel — the shared button-content group', () => {
  it('without an icon, centres the label alone in the box', () => {
    const box = new PIXI.Container();
    drawButtonLabel(box, 100, 50, 300, 60, 'Claim', null, COLOR, FS);

    expect(box.children).toHaveLength(1);
    const [label] = texts(box);
    expect(label).toBeDefined();
    // anchor is (0, 0.5): x is the left edge, y the vertical middle.
    expect(Math.abs(label!.x + label!.width / 2 - (100 + 300 / 2))).toBeLessThanOrEqual(1);
    expect(label!.y).toBe(50 + 60 / 2);
  });

  it('with an icon, centres the icon+label GROUP (not the label) and keeps the label full size', () => {
    const box = new PIXI.Container();
    drawButtonLabel(box, 100, 50, 300, 60, 'Claim', 'gift', COLOR, FS);

    expect(box.children).toHaveLength(2);
    const [label] = texts(box);
    const glyph = box.children.find((c) => !(c instanceof PIXI.Text))!;
    expect(label).toBeDefined();
    expect(glyph).toBeDefined();

    // Group spans the glyph's left edge to the label's right edge, centred in the box.
    const groupCentre = (glyph.x + label!.x + label!.width) / 2;
    expect(Math.abs(groupCentre - (100 + 300 / 2))).toBeLessThanOrEqual(1);
    // Room to spare → nothing is scaled down.
    expect(label!.scale.x).toBe(1);
    // The label sits to the RIGHT of the glyph, by the icon box + gap.
    expect(Math.abs(label!.x - glyph.x - buttonLabelIconW(FS))).toBeLessThanOrEqual(1);
  });

  it('drops the icon rather than shrinking the label when the button is too narrow for both', () => {
    const wide = new PIXI.Container();
    drawButtonLabel(wide, 0, 0, 300, 40, 'Accept', 'check', COLOR, FS);
    const [wideLabel] = texts(wide);

    const narrow = new PIXI.Container();
    // Barely wider than the label itself — the group would have to scale well under minFit.
    drawButtonLabel(narrow, 0, 0, Math.ceil(wideLabel!.width) + 12, 40, 'Accept', 'check', COLOR, FS);

    expect(wide.children).toHaveLength(2);
    expect(narrow.children).toHaveLength(1); // glyph dropped
    const [narrowLabel] = texts(narrow);
    expect(narrowLabel!.scale.x).toBe(1); // and the label kept its size
  });

  it('stacks the glyph above the label for a square cell', () => {
    const box = new PIXI.Container();
    drawButtonLabel(box, 0, 0, 90, 90, 'Daily', 'checkinTabIcon', COLOR, FS, { stack: true });

    expect(box.children).toHaveLength(2);
    const [label] = texts(box);
    const glyph = box.children.find((c) => !(c instanceof PIXI.Text))!;
    // Column, not a row: the label starts below the glyph and both are horizontally centred.
    expect(label!.y).toBeGreaterThan(glyph.y);
    expect(label!.anchor.x).toBe(0.5);
    expect(Math.abs(label!.x - 45)).toBeLessThanOrEqual(1);
  });
});
