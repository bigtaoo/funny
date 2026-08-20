// The back-button arrow (19.08.2026) is packed by pack_tab_icons.cjs like a tab icon, but it is
// deliberately NOT one: it never enters `TAB_ICON_RASTER`, nothing dispatches to it via `buildIcon`,
// and its ink set is `accent` (blue, for the paper title bar) + `active` (white, for LoginScene's
// dark bar) instead of the tab triple. `tabIconContentVariant.test.ts` therefore excludes it; these
// are the contracts that replace the ones it skips.
//
// The one worth the file on its own is BACK_ARROW_ASPECT. SceneHeader reserves the arrow's width
// from that CONSTANT rather than from the decoded texture, because the pill behind it is baked into
// uiCache on first draw — a width read off the texture would depend on whether the PNG had decoded
// yet, and bake a pill that doesn't fit its own contents. That makes the constant a silent liability
// the day the art is redrawn at a different aspect: nothing would throw, the arrow would just sit
// wrong inside a chip sized for the old shape. Run: npm test
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { BACK_ARROW_ASPECT } from '../../src/render/icons';

const ASSET_DIR = path.resolve(__dirname, '../../src/assets/tabicons');
const INKS = ['accent', 'active'] as const;

/** Width/height straight out of the PNG's IHDR chunk — no image decoder needed. */
function pngSize(file: string): { w: number; h: number } {
  const buf = fs.readFileSync(path.join(ASSET_DIR, file));
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe('back-arrow art', () => {
  it('ships exactly the two inks the back button draws, and no tab inks', () => {
    for (const ink of INKS) {
      expect(fs.existsSync(path.join(ASSET_DIR, `back_${ink}.png`)), `back_${ink}.png`).toBe(true);
    }
    for (const ink of ['inactive', 'content']) {
      expect(fs.existsSync(path.join(ASSET_DIR, `back_${ink}.png`)), `back_${ink}.png should not exist`).toBe(false);
    }
  });

  it('bakes a genuinely different ink into each variant', () => {
    const [a, b] = INKS.map((ink) => fs.readFileSync(path.join(ASSET_DIR, `back_${ink}.png`)));
    expect(a!.equals(b!)).toBe(false);
  });

  it('packs both inks at the same pixel size (both are thickened the same)', () => {
    const [a, b] = INKS.map((ink) => pngSize(`back_${ink}.png`));
    expect(a).toEqual(b);
  });

  it('matches BACK_ARROW_ASPECT — redraw the art at a new aspect and this is what tells you', () => {
    const { w, h } = pngSize('back_accent.png');
    expect(BACK_ARROW_ASPECT).toBeCloseTo(w / h, 5);
  });

  // A near-square arrow would mean the source was drawn with a much shorter shaft, which changes how
  // much of the pill it eats and how heavy its stroke lands after minification — worth a nudge to
  // re-check the layout rather than letting it through silently.
  it('is still the wide arrow the chip layout assumes', () => {
    expect(BACK_ARROW_ASPECT).toBeGreaterThan(1.5);
    expect(BACK_ARROW_ASPECT).toBeLessThan(3);
  });
});
