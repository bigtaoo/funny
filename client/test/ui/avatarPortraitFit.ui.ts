// Cover for render/avatar.ts's portrait framing. Runs under the headless PIXI adapter
// (vitest.ui.config.ts setupFiles) because buildAvatar builds real display objects.
//
// Two things are pinned here, both from the 2026-08-15 avatar pass (plus skin busts added 2026-08-17):
//  1. The fit re-runs when the art finishes loading. Avatar art loads async and nothing re-renders
//     an avatar (it's a leaf builder, not a scene), so a build-time-only fit left every avatar
//     scaled off the placeholder texture on a cold load and the circle cropped into the hair.
//  2. Every portrait frames the same way — hair top just inside the rim, crop landing at the neck —
//     which is what the per-portrait head boxes in portraitHeadBox.ts buy over a global constant.
//     This is the test that catches a new/repainted portrait whose head box was never measured.
// Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { buildAvatar, makeAvatarId } from '../../src/render/avatar';
import { getArtTexture } from '../../src/render/cardArt';
import { PRESET_AVATAR_KEYS, PRESET_AVATAR_ART_URLS } from '../../src/render/presetAvatarArt';
import { HERO_AVATAR_KEYS } from '../../src/render/heroAvatarArt';
import { SKIN_AVATAR_KEYS } from '../../src/render/skinAvatarArt';
import { PRESET_HEAD_BOX, HERO_HEAD_BOX, SKIN_HEAD_BOX, type HeadBox } from '../../src/render/portraitHeadBox';

/** Every bust portrait is 512×768; the harness stubs all *.png imports to one 1×1 data URI. */
const SRC_W = 512, SRC_H = 768;

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

/** Pretend the shared stub texture is a real 512×768 portrait that just finished downloading. */
function completeLoad(): PIXI.Texture {
  const tex = getArtTexture(PRESET_AVATAR_ART_URLS.gogetter);
  tex.baseTexture.setRealSize(SRC_W, SRC_H);
  tex.baseTexture.valid = true;
  tex.baseTexture.emit('loaded', tex.baseTexture);
  return tex;
}

describe('buildAvatar — portrait fit', () => {
  it('re-fits the portrait once its texture reports its real size', () => {
    // Driven through the skin category on purpose: avatar_skin_shop_e1.png's master art came out a
    // slightly different aspect ratio than the other 31 bust portraits (512×683, not 512×768), so
    // the pre-load guess (avatar.ts's BUST_W/BUST_H, assumed for every category now that skin busts
    // also carry a head box) disagrees with the real size enough to observe the re-fit. The other 31
    // busts are exactly 512×768 — identical to the guess — so they can't show this on their own; the
    // exhaustive framing test below covers their geometry instead.
    const tex = getArtTexture(PRESET_AVATAR_ART_URLS.gogetter); // same stub texture for every png here
    tex.baseTexture.valid = false; // cold-load state, whatever earlier tests left behind

    const sprite = portraitSprite(buildAvatar(100, '', 7, makeAvatarId('skin', 'skin_shop_e1')));
    const beforeLoad = sprite.scale.x;

    tex.baseTexture.setRealSize(512, 683); // avatar_skin_shop_e1.png's real dimensions
    tex.baseTexture.valid = true;
    tex.baseTexture.emit('loaded', tex.baseTexture);

    // Disc diameter 96 (size - 4) × 0.92 = an 88px circle; head span/width-cap fractions of 0.90/0.88
    // mirror avatar.ts's HEAD_SPAN/HEAD_MAX_W.
    const head = SKIN_HEAD_BOX.skin_shop_e1;
    const byHeight = (0.9 * 88) / ((head.bottom - head.top) * 683);
    const byWidth = (0.88 * 88) / (head.width * 512);
    expect(sprite.scale.x).toBeCloseTo(Math.min(byHeight, byWidth), 4);
    expect(sprite.scale.x).not.toBeCloseTo(beforeLoad, 4);
  });

  it('fits a bust from its head box once loaded', () => {
    completeLoad();
    const sprite = portraitSprite(buildAvatar(100, '', 7, makeAvatarId('preset', 'gogetter')));
    // gogetter's head is wide enough that the width cap, not the height, decides the scale.
    expect(sprite.scale.x).toBeCloseTo((0.88 * 88) / (PRESET_HEAD_BOX.gogetter.width * SRC_W), 4);
  });

  it('frames every portrait the same way: hair inside the rim, crop at the neck, no side gaps', () => {
    const cases: Array<[string, string, HeadBox]> = [
      ...PRESET_AVATAR_KEYS.map((k) => ['preset', k, PRESET_HEAD_BOX[k]] as [string, string, HeadBox]),
      ...HERO_AVATAR_KEYS.map((k) => ['hero', k, HERO_HEAD_BOX[k]] as [string, string, HeadBox]),
      ...SKIN_AVATAR_KEYS.map((k) => ['skin', k, SKIN_HEAD_BOX[k]] as [string, string, HeadBox]),
    ];
    completeLoad();

    for (const [category, key, head] of cases) {
      const size = 100;
      const sprite = portraitSprite(buildAvatar(size, '', 7, makeAvatarId(category as 'preset', key)));
      const d = Math.round((size / 2 - 2) * 2 * 0.92); // the portrait circle's diameter
      const at = (srcY: number): number => sprite.y + srcY * SRC_H * sprite.scale.y;

      expect(at(head.top), `${key}: hair top must stay inside the circle`).toBeGreaterThanOrEqual(0);
      expect(at(head.top), `${key}: hair top must not float far below the rim`).toBeLessThan(d * 0.12);
      // A hair past the bottom is fine — the circle is pinched to nothing down there, and portraits
      // with a tall head (hero_infantry) get scaled up by the cover-the-width floor.
      expect(at(head.bottom), `${key}: the crop must not run down into the chest`).toBeLessThan(d * 1.05);
      expect(at(head.bottom), `${key}: the crop must reach the neck, not stop at the chin`).toBeGreaterThan(d * 0.7);
      expect(SRC_W * sprite.scale.x, `${key}: art must cover the circle's full width`).toBeGreaterThanOrEqual(d);
    }
  });
});
