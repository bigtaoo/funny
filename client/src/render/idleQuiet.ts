// "Nobody has touched this screen in a while" — the one bit decorative animations read to stop
// animating.
//
// A module of its own, with NO imports, for the same two reasons `render/renderStats.ts` has none:
//
//   1. The readers (`render/boil.ts`, `render/stickman/StickmanRuntime.ts`, the world map's shield
//      bubbles) are constructed nowhere near the render loop, and threading a policy handle down to
//      each of them would be a wide change for one boolean.
//   2. `render/renderPolicy.ts` imports PIXI as a *value*, so importing it drags the whole canvas
//      renderer — and its `document.createElement` at module load — into every consumer. Several of
//      the readers run in the plain-node unit suite. Reading this flag costs them nothing.
//
// Written only by `RenderPolicy` (which is the only thing that knows when the last pointer event
// was). Default `false`, so anything running without a policy installed — the animator, the map
// editor, every unit test — animates exactly as it did before this existed.

let quiet = false;

/**
 * Publish the flag. Called once per tick by `RenderPolicy`; `false` on `uninstall` so a torn-down
 * policy cannot leave decorations frozen for whatever runs next in the same process (tests).
 */
export function setDecorationsQuiet(q: boolean): void { quiet = q; }

/**
 * True when purely decorative motion should hold its current frame.
 *
 * What may read this: charm only — the boiling line wobble, menu stickman silhouettes, the world
 * map's shield bubbles. What may NOT: anything a player reads a value off (HUD countdowns), any
 * progress indicator (a frozen loading spinner reads as a hang), and any attention cue the game
 * itself raised (the onboarding guide ring). The test for it is "would a screenshot taken while
 * frozen look wrong, or just look like a drawing".
 */
export function decorationsQuiet(): boolean { return quiet; }
