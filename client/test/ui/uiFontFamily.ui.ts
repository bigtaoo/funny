// The UI's one font family (render/theme.ts UI_FONT_FAMILY), on the paths that used to fall back to
// PIXI's built-in Arial because their style named no family: makeText() itself, and the hand card
// slot (name / cost / type), which was the most visible Arial in the game. The source-level guard
// against raw `fontFamily:` literals is test/uiFontFamily.test.ts; this is the runtime half, and
// needs the headless canvas (makeText constructs a PIXI.Text).
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../src/render/pixiText';
import { UI_FONT_FAMILY } from '../../src/render/theme';
import { createCardSlot } from '../../src/render/HandView/cellDraw';

describe('UI font family at runtime', () => {
  it("makeText fills in the UI family when a style names none (PIXI's default is Arial)", () => {
    expect(makeText('x', { fontSize: 12 }).style.fontFamily).toBe(UI_FONT_FAMILY);
    expect(makeText('x').style.fontFamily).toBe(UI_FONT_FAMILY);
  });

  it('an explicit family still wins, and a TextStyle instance is left as the caller built it', () => {
    expect(makeText('x', { fontFamily: 'cursive' }).style.fontFamily).toBe('cursive');
    const own = new PIXI.TextStyle({ fontSize: 12, fontFamily: 'fantasy' });
    expect(makeText('x', own).style.fontFamily).toBe('fantasy');
  });

  it('every text in a hand card slot is drawn in the UI family', () => {
    const slot = createCardSlot();
    const texts = slot.children.filter((c): c is PIXI.Text => c instanceof PIXI.Text);
    expect(texts.map((t) => t.name).sort()).toEqual(['cost', 'name', 'type']);
    for (const t of texts) expect(t.style.fontFamily, t.name ?? '').toBe(UI_FONT_FAMILY);
  });
});
