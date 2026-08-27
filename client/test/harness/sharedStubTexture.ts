// Reset for the ONE texture every portrait shares in the headless UI harness.
//
// The hazard, and why it needs a helper rather than a comment. `vitest.ui.config.ts`'s
// `stubBinaryAssets` plugin resolves EVERY `*.png` import to the same 1×1 transparent data URI, and
// `render/cardArt.ts`'s `getArtTexture(url)` caches by url — so in this harness every character
// portrait, every avatar bust and every skin bust is literally the same `PIXI.Texture` object. Both
// files that simulate "the art finished streaming in" do it by mutating that shared BaseTexture in
// place (`valid = true`, `setRealSize(...)`, `emit('loaded')`), and nothing put it back.
//
// Vitest's per-file isolation does not help: the leak is WITHIN a file, from one `it()` to the next.
// So any test whose premise is "this portrait has not loaded yet" — a spinner is drawn, or the
// pre-load size guess is still in effect — passed only because it happened to be DECLARED before the
// test that flipped the flag. Running the suite with `--sequence.shuffle` fails 5 runs in 8 in
// `avatarPortraitFit.ui.ts` alone, and up to 4 tests at once in `cardArtLoadingSpinner.ui.ts`. That
// is the intermittent `test:ui` red seen on 2026-08-27 (misattributed at the time to a FamilyScene
// emblem-badge case, which is not involved and does not touch this texture).
//
// There is a second, subtler channel than `valid` and the real size, and it is the one that actually
// bit: **`PIXI.Texture.frame`**, plus the listener that maintains it. Texture's constructor does
//
//     baseTexture.valid ? ... : baseTexture.once('loaded', this.onBaseTextureUpdated, this),
//     this.noFrame && baseTexture.on('update', this.onBaseTextureUpdated, this)
//
// — so `'loaded'` is a ONE-SHOT and `'update'` is persistent. The first test to `emit('loaded')`
// consumes the one-shot forever. Every later test that fakes a load by emitting `'loaded'` therefore
// does NOT resync the frame, and app code reading `tex.width` (avatar.ts's fit does exactly that)
// sees the PREVIOUS test's dimensions. Measured: the re-fit case read a 768-tall frame while the
// baseTexture said 683, giving scale 0.2258 instead of 0.2333.
//
// So both halves matter: a test simulating a load must set `valid` BEFORE `setRealSize()` (which
// then runs BaseTexture.update() and fires the persistent 'update' listener), and the reset here
// must put the frame back too.
//
// Call `resetSharedStubTexture()` from a `beforeEach` in any UI test that depends on load state.
// Pristine values measured, not guessed: `valid: false`, frame 1x1.
import { getArtTexture } from '../../src/render/cardArt';
import { PRESET_AVATAR_ART_URLS } from '../../src/render/presetAvatarArt';

/**
 * Put the shared stub texture back to the state it has on a cold module load: not valid, no size.
 *
 * Any url works — they all resolve to the same cached texture in this harness — but going through
 * `getArtTexture` rather than poking `PIXI.utils.TextureCache` keeps this honest: if the stubbing
 * ever changes so that portraits DON'T share one texture, this helper stops being able to reach
 * them all and the affected tests fail loudly instead of silently reverting to order-dependence.
 */
export function resetSharedStubTexture(): void {
  const base = getArtTexture(PRESET_AVATAR_ART_URLS.gogetter).baseTexture;
  // Deliberately valid=true across the setRealSize call: that is the ONLY way to make PIXI resync
  // Texture.frame here (setRealSize runs update() only while valid, and update() is what fires the
  // persistent 'update' listener). 1x1 rather than 0x0 because that is the stub PNG's true size, and
  // because avatar.ts gates on `tex.width > 1` — so 1x1 reads as "not loaded yet" exactly like the
  // pristine state does, without a zero sneaking into a division.
  base.valid = true;
  base.setRealSize(1, 1);
  base.valid = false;
}
