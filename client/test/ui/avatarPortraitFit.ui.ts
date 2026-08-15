// Regression cover for render/avatar.ts's portrait sizing. Runs under the headless PIXI adapter
// (vitest.ui.config.ts setupFiles) because buildAvatar builds real display objects.
//
// The bug this pins (2026-08-15): buildPortraitIcon fitted the sprite ONCE, at build time, from
// `tex.width`. Avatar art loads async and nothing re-renders an avatar (it's a leaf builder, not a
// scene), so on a cold load every avatar kept the scale computed from the not-yet-loaded texture's
// size and the circle cropped straight into the portrait's hair — the reported "头像截取不对" on
// the settings/picker screens. Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { buildAvatar, makeAvatarId } from '../../src/render/avatar';
import { getArtTexture } from '../../src/render/cardArt';
import { PRESET_AVATAR_ART_URLS } from '../../src/render/presetAvatarArt';

/** The lone PIXI.Sprite inside an avatar container (the portrait; the disc/rim are Graphics). */
function portraitSprite(avatar: PIXI.Container): PIXI.Sprite {
  const sprites: PIXI.Sprite[] = [];
  const walk = (node: PIXI.Container): void => {
    for (const child of node.children) {
      if (child instanceof PIXI.Sprite) sprites.push(child);
      else if (child instanceof PIXI.Container) walk(child);
    }
  };
  walk(avatar);
  expect(sprites).toHaveLength(1);
  return sprites[0]!;
}

describe('buildAvatar — portrait fit', () => {
  it('re-fits the portrait once its texture reports its real size', () => {
    // Every *.png import resolves to the SAME stubbed 1×1 data URI in this harness
    // (vitest.ui.config.ts stubBinaryAssets), so the texture starts 1×1 and invalid — exactly the
    // cold-load state the production code has to survive.
    const tex = getArtTexture(PRESET_AVATAR_ART_URLS.gogetter);
    expect(tex.baseTexture.valid).toBe(false);

    const avatar = buildAvatar(100, '', 7, makeAvatarId('preset', 'gogetter'));
    const sprite = portraitSprite(avatar);
    const beforeLoad = sprite.scale.x;

    // Fake "the real art finished downloading" — the harness' stubbed Image never fires load.
    tex.baseTexture.setRealSize(512, 768);
    tex.baseTexture.valid = true;
    tex.baseTexture.emit('loaded', tex.baseTexture);

    // Disc diameter 96 (size - 4) × 0.92 portrait fill = 88px circle, ×1.10 bust zoom.
    expect(sprite.scale.x).toBeCloseTo((88 / 512) * 1.10, 4);
    expect(sprite.scale.x).not.toBeCloseTo(beforeLoad, 4);
  });

  it('leaves a thin rim rather than overflowing the disc, down to the map tokens 16px floor', () => {
    for (const size of [16, 44, 76, 150]) {
      const avatar = buildAvatar(size, '', 7, makeAvatarId('preset', 'gogetter'));
      const sprite = portraitSprite(avatar);
      // The mask circle is the sprite's sibling and defines the visible portrait disc.
      const mask = sprite.mask as PIXI.Graphics;
      const portraitD = mask.getLocalBounds().width;
      const discD = (size / 2 - 2) * 2;
      expect(portraitD, `portrait must stay inside the disc @ ${size}px`).toBeLessThanOrEqual(discD);
      expect(portraitD, `portrait must still dominate the tile @ ${size}px`).toBeGreaterThan(size * 0.6);
    }
  });
});
