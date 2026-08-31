// Regression coverage for the 2026-08-30 fix: an icon whose PNG had not decoded yet stayed blank
// FOREVER in any panel that renders once.
//
// `PIXI.Texture.from` is lazy — the first call for a url kicks off the fetch and hands back a
// texture whose baseTexture is `valid === false`. Both icon builders used to answer that with an
// empty Container, on the assumption (written into their doc comments) that "the caller's next
// render fixes it". Scenes that re-render on a ticker do get fixed; a modal built once when it opens
// does not. The world-map shop panel is the latter: open it on a cold texture cache and every card
// icon is missing — the battle-pass trophy being the one usually still missing in practice, since
// the other kinds' art is warmed by scenes a player passes through first (hourglass/armor in the
// equipment screens, coinChest as a raster tab icon). It became obvious once the blue frame that
// used to sit around the icon was removed.
//
// The fix is in `buildFittedSprite` (render/cardArt.ts), not in the shop panel: the sprite is always
// added, hidden until its texture decodes, and fits + shows itself on the baseTexture's `loaded`
// event. So every one of the ~40 buildIcon call sites is covered, with no per-caller re-render hook.
//
// Run: npm run test:ui
import { describe, it, expect, beforeEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { buildIcon, INK_ICON_ART } from '../../src/render/icons';
import { getArtTexture } from '../../src/render/cardArt';
import { resetSharedStubTexture } from '../harness/sharedStubTexture';

const SIZE = 84;                       // the world-map shop card's icon slot, near enough
const TROPHY = INK_ICON_ART.trophy;    // battle_pass's kind icon — the reported symptom

/** The one texture every `.png` import shares in this harness (see harness/sharedStubTexture.ts). */
const stubTex = (): PIXI.Texture => getArtTexture(TROPHY);

/** "The PNG finished decoding": real size first (that resyncs Texture.frame), then the event. */
function finishDecode(w: number, h: number): void {
  const base = stubTex().baseTexture;
  base.valid = true;
  base.setRealSize(w, h);
  base.emit('loaded', base);
}

function spritesIn(node: PIXI.Container): PIXI.Sprite[] {
  const out: PIXI.Sprite[] = [];
  const walk = (n: PIXI.Container): void => {
    if (n instanceof PIXI.Sprite) out.push(n);
    for (const c of n.children) walk(c as PIXI.Container);
  };
  walk(node);
  return out;
}

describe('icon art fills itself in when its texture decodes (no re-render needed)', () => {
  beforeEach(() => { resetSharedStubTexture(); });

  it('an icon built against a still-decoding texture draws nothing, and measures as an empty box so no layout depends on the decode', () => {
    const icon = buildIcon('trophy', SIZE, 0x4477cc) as PIXI.Container;

    const sprites = spritesIn(icon);
    expect(sprites, 'the sprite is created up front — that is what lets it fix itself later').toHaveLength(1);
    expect(sprites[0].visible, 'a 1x1 frame scaled into the slot would smear across the card').toBe(false);
    // Invisible children are skipped by Container.calculateBounds, so callers that measure an icon
    // still see the same empty box the old "return an empty Container" behaviour gave them.
    expect(icon.getBounds().width).toBe(0);
  });

  it('the SAME icon object shows correctly-fitted art once the texture decodes — nothing rebuilds it', () => {
    const icon = buildIcon('trophy', SIZE, 0x4477cc) as PIXI.Container;
    const sprite = spritesIn(icon)[0];

    finishDecode(128, 123);   // trophy_active.png's real dimensions

    expect(sprite.visible, 'still hidden after the decode — the icon never appears').toBe(true);
    // Contain-fit and centred in the SIZExSIZE box, the positioning contract every caller assumes.
    const scale = Math.min(SIZE / 128, SIZE / 123);
    expect(sprite.scale.x).toBeCloseTo(scale, 5);
    expect(sprite.x).toBeCloseTo((SIZE - 128 * scale) / 2, 5);
    expect(sprite.y).toBeCloseTo((SIZE - 123 * scale) / 2, 5);
    expect(sprite.tint, 'ink icons are tinted live off a white master').toBe(0x4477cc);
  });

  it('an icon torn down before its texture lands neither throws nor keeps itself alive through the (globally cached) baseTexture', () => {
    const icon = buildIcon('trophy', SIZE, 0x4477cc) as PIXI.Container;
    const base = stubTex().baseTexture;
    const hooked = base.listenerCount('loaded');

    // tearDownChildren's disposal path: the panel closed before the PNG arrived.
    icon.destroy({ children: true });
    expect(base.listenerCount('loaded'), 'the destroyed sprite is still hanging off the shared baseTexture').toBe(hooked - 1);

    // The decode lands afterwards. Touching a destroyed Sprite here throws from inside a PIXI Runner
    // on the shared ticker, which kills Ticker.shared and freezes the canvas until a page reload
    // (菜单场景生命周期契约, claudedocs/client-modules.md) — so this must be a no-op, not a throw.
    expect(() => finishDecode(128, 123)).not.toThrow();
  });

  it('an icon built AFTER its texture decoded is fitted and shown straight away — the preloadIconArt path takes no extra frame', () => {
    finishDecode(128, 123);   // preloadInkIconTextures() got there first

    const sprite = spritesIn(buildIcon('trophy', SIZE, 0x4477cc) as PIXI.Container)[0];

    expect(sprite.visible, 'nothing will fire a second `loaded` for an already-decoded texture').toBe(true);
    expect(sprite.scale.x).toBeCloseTo(Math.min(SIZE / 128, SIZE / 123), 5);
  });

  it('the raster half of the icon set (pre-baked inks, never tinted) self-heals the same way', () => {
    const icon = buildIcon('coinChest', SIZE, 0xffffff) as PIXI.Container;
    const sprite = spritesIn(icon)[0];
    expect(sprite.visible).toBe(false);

    finishDecode(100, 50);

    expect(sprite.visible).toBe(true);
    expect(sprite.scale.x).toBeCloseTo(SIZE / 100, 5);
    expect(sprite.y, 'letterboxed on the short axis').toBeCloseTo((SIZE - 50 * (SIZE / 100)) / 2, 5);
  });
});
