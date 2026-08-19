/**
 * towerArtContract.test.ts — the two things about the battle arrow tower's art that break silently.
 *
 * 1. ITS ASPECT. `BuildingView` sizes building sprites with `sp.width = sp.height = SPRITE_SIZE`,
 *    i.e. it *stretches* the texture into a square (the same convention BoardView/bases.ts uses).
 *    The art is drawn to survive that — a slim tower whose bottom corners are filled with rubble
 *    and an arrow barrel so the ink bounding box comes out ~1:1 — and that constraint is the whole
 *    reason the prompt in design/product/battle-arrow-tower-art.md reads the way it does. Redraw or
 *    re-crop the art at 3:2 and nothing throws: the tower just quietly renders squashed, which is
 *    exactly the defect the redraw was meant to fix (the hut it replaced was 1.57:1).
 *
 * 2. THE HAND AND THE BOARD SHOWING THE SAME BUILDING. cardArt.ts's own contract is that the battle
 *    hand and the codex draw the same picture as the board; the tower asset is wired at four sites
 *    and one of them was missed on the first pass. Pinning both ends against the file itself makes a
 *    half-done swap fail here instead of in a screenshot.
 *
 * Deliberately NOT tested here: ink colour, edge hardness, 56px contrast. Those need to decode the
 * PNG, and `sharp` is only a transitive dependency of this workspace — a test that imports it would
 * be a CI liability. They are enforced at pack time instead (art/ui/game/pack_arrow_tower.cjs prints
 * and thresholds all four), which is the right place: they are properties of the *packing*, and
 * re-packing is the only way they change. The IHDR read below needs no decoder at all.
 *
 * Run with: npm test
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { BuildingType } from '@nw/engine/types';
import { CARD_ART_URLS } from '../../src/render/cardArt';
import towerArtUrl from '../../src/assets/buildings/game_arrow_tower.png';
import barracksArtUrl from '../../src/assets/buildings/game_infantry_barracks.png';

const ASSET_DIR = path.resolve(__dirname, '../../src/assets/buildings');

/** Width/height straight out of the PNG's IHDR chunk — no image decoder needed. */
function pngSize(file: string): { w: number; h: number } {
  const buf = fs.readFileSync(path.join(ASSET_DIR, file));
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe('battle arrow tower art', () => {
  it('ships the asset the board and the cards import', () => {
    expect(fs.existsSync(path.join(ASSET_DIR, 'game_arrow_tower.png'))).toBe(true);
  });

  it('is drawn ~square, because the board sprite stretches it into a square box', () => {
    const { w, h } = pngSize('game_arrow_tower.png');
    const aspect = w / h;
    // Same window the packing script accepts (0.95–1.10). The retired hut scored 1.57 here.
    expect(aspect).toBeGreaterThanOrEqual(0.95);
    expect(aspect).toBeLessThanOrEqual(1.10);
  });

  it('is the same file the arrow-tower card face uses', () => {
    expect(CARD_ART_URLS[`building_${BuildingType.ArrowTower}`]).toBe(towerArtUrl);
  });

  it('is not the barracks art — the tower borrowed the barracks-family file for a long time', () => {
    expect(CARD_ART_URLS[`building_${BuildingType.Barracks}`]).toBe(barracksArtUrl);
    expect(towerArtUrl).not.toBe(barracksArtUrl);
  });
});
