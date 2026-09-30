/**
 * stageSignature.ts — the display-tree hash behind `RenderPolicy`'s reactive painting.
 *
 * Split out of renderPolicy.ts (which re-exports {@link stageSignature} and
 * {@link setSignatureCovered}) to keep both under the 500-line convention; the rationale for
 * deriving "did the picture change" instead of announcing it lives in renderPolicy.ts.
 */
import * as PIXI from 'pixi.js-legacy';


/** FNV-1a step. Kept inline-able and integer-only so the walk allocates nothing. */
function mix(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), 0x01000193) >>> 0;
}

function mixString(h: number, s: string): number {
  let out = h;
  for (let i = 0; i < s.length; i++) out = mix(out, s.charCodeAt(i));
  return mix(out, s.length);
}

/**
 * Every field of a display object the renderer's output depends on, folded into one number.
 *
 * What is deliberately read, and why each one is load-bearing:
 * - `visible` / `renderable` / `alpha` / `tint` — the cheap ways a scene shows and hides things.
 * - `transform._localID` — PIXI bumps this on any position/scale/rotation/skew/pivot write, so one
 *   integer covers every kind of movement. World transforms are NOT read: they are recomputed
 *   during render, which we may be skipping, and a parent's own `_localID` is already in the hash.
 * - `baseTexture.uid` + the frame rect + `baseTexture.dirtyId` — an atlas frame swap moves the
 *   frame; a different image moves the uid; an image finishing its decode (or a `Text`
 *   re-rasterising into its canvas) moves `dirtyId`. Without the last one, late art would pop in
 *   only on the next floor tick.
 * - `geometry.dirty` — `Graphics` bumps it on `clear()` and on every drawing op, which is how a
 *   re-stroked panel or a redrawn HUD announces itself.
 * - `text` — a label rewritten to the same width is otherwise invisible to every other field.
 * - `children.length` and recursion order — covers add/remove/reparent. `zIndex` is read as a value
 *   rather than via the container's `sortDirty` flag: sorting happens inside render, so between two
 *   paints the child array is still in the old order, and `sortDirty` can already be true from an
 *   unrelated `addChild` (which is exactly how the first version of this let a reorder through).
 *
 * A mask needs no field of its own: PIXI's `mask` setter flips the mask object's `renderable`, and
 * every mask in this codebase is a child of the tree it clips, so the change is already hashed.
 *
 * Every field above is pinned by a case in test/ui/renderPolicy.ui.ts that goes red when the line
 * is deleted, except `visible` and `children.length`: those two are implied by the walk's shape
 * (a hidden subtree is not descended into; an added child folds in more values) and are kept only
 * to stop the hash from being structurally ambiguous. Redundant fields were REMOVED rather than
 * left unpinned. Four were in the first version and none of them could be made to matter:
 * `graphicsData.length` (always moves with `geometry.dirty`), `sortDirty` (always moves with
 * `zIndex`), `baseTexture.valid` (PIXI derives it from the size, which moves `dirtyId`) and a
 * `mask` presence bit.
 */
export function stageSignature(root: PIXI.Container): number {
  walkHash = 0x811c9dc5;
  walkRenderMutates = false;
  visit(root);
  return walkHash;
}

/**
 * Subtrees the walk folds in as a constant instead of descending: a scene sitting under a
 * full-screen overlay (SceneManager.pushOverlay). Its pixels are painted over completely, so no
 * change inside it can be seen — and it is the bulk of the tree: the world map under the City
 * overlay is 1,553 of 2,526 nodes, walked 90 times a second for nothing (ADR-101).
 *
 * An array compared by identity rather than a WeakSet or a flag on the object: the check runs on
 * every node, and a length test on an empty array is the cheapest thing the walk does.
 */
const coveredRoots: PIXI.DisplayObject[] = [];

/**
 * Mark `root` as painted over (or not any more). Called by `SceneManager` around an overlay; the
 * overlay itself calls {@link invalidateRender} on the way in and out, so the switch always paints.
 */
export function setSignatureCovered(root: PIXI.DisplayObject, covered: boolean): void {
  const i = coveredRoots.indexOf(root);
  if (covered && i < 0) coveredRoots.push(root);
  else if (!covered && i >= 0) coveredRoots.splice(i, 1);
}

// Walk state as module variables rather than a closure: one allocation fewer per walk, and a plain
// recursive function is what V8 inlines best on a 2,000-node tree walked every tick.
let walkHash = 0;
/**
 * Whether the tree just walked holds something the NEXT render will itself change in a way the
 * signature reads: a `Text` / `BitmapText` waiting to re-rasterise (new texture frame, new glyph
 * children) or a container waiting to sort. Tells {@link RenderPolicy} whether the pre-paint
 * signature can stand in as the post-paint baseline, which saves a whole second walk (ADR-101).
 */
let walkRenderMutates = false;

/** Whether the walk just run left something the next render will itself change (see above). */
export function lastWalkRenderMutates(): boolean {
  return walkRenderMutates;
}

type Walked = PIXI.DisplayObject & {
  visible?: boolean; renderable?: boolean; alpha?: number; tint?: number;
  transform?: { _localID?: number };
  texture?: {
    baseTexture?: { uid?: number; dirtyId?: number };
    frame?: { x: number; y: number; width: number; height: number };
  };
  geometry?: { dirty?: number };
  text?: unknown;
  dirty?: unknown;
  children?: PIXI.DisplayObject[];
  zIndex?: number;
  sortableChildren?: boolean;
  sortDirty?: boolean;
};

function visit(o: PIXI.DisplayObject): void {
  const d = o as Walked;
  let h = walkHash;
  const shown = d.visible !== false;
  h = mix(h, shown ? 2 : 1);
  if (!shown) { walkHash = h; return; }
  if (coveredRoots.length !== 0 && coveredRoots.includes(o)) { walkHash = mix(h, 5); return; }
  h = mix(h, d.renderable === false ? 3 : 4);
  h = mix(h, Math.round((d.alpha ?? 1) * 1024));
  h = mix(h, d.tint ?? 0);
  h = mix(h, d.transform?._localID ?? 0);
  h = mix(h, d.zIndex ?? 0);
  const tex = d.texture;
  if (tex) {
    // `baseTexture.uid` + the frame rect, NOT `texture.uid` — PIXI's `Texture` has no `uid` at
    // all (only `BaseTexture` does), so the first version of this line hashed `undefined` on
    // every sprite in the tree and an atlas frame swap went undetected. Caught by the mutation
    // sweep in test/ui/renderPolicy.ui.ts: deleting the line changed nothing.
    h = mix(h, tex.baseTexture?.uid ?? 0);
    const f = tex.frame;
    if (f) h = mix(mix(mix(mix(h, f.x), f.y), f.width), f.height);
    h = mix(h, tex.baseTexture?.dirtyId ?? 0);
  }
  if (d.geometry) h = mix(h, d.geometry.dirty ?? 0);
  if (typeof d.text === 'string') {
    h = mixString(h, d.text);
    if (d.dirty === true) walkRenderMutates = true;
  }
  const kids = d.children;
  if (kids) {
    h = mix(h, kids.length);
    if (d.sortableChildren && d.sortDirty) walkRenderMutates = true;
    walkHash = h;
    for (let i = 0; i < kids.length; i++) visit(kids[i]!);
    return;
  }
  walkHash = h;
}

