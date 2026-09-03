// IOController's SpriteBinding -> JSON conversion, extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛") — a pure function of its argument,
// no IOController instance state involved at all.
//
// WHY this exists rather than the `{ ...b }` spread it replaced: a spread copies keys the
// SpriteBinding type never declared, so a field dropped from the type keeps round-tripping
// through save/load/export forever, invisible to both the type checker and the artist.
// That is exactly what happened to `offsetX`/`offsetY` — a binding-level offset channel
// that existed 2026-06-05..09, was removed in favour of out-of-range anchors, and then
// rode along in 7 shipped bundles for ten weeks because every hop was an untyped spread.
// Listing the seven fields explicitly means the writer emits exactly what the type declares:
// a field removed from the type stops being written, and adding one is a compile error here
// until it is handled. See claudedocs/file-formats.md.
import type { SpriteBinding } from '../core/types';

export function serializeBinding(b: SpriteBinding): SpriteBinding {
  return {
    anchorX:  b.anchorX,
    anchorY:  b.anchorY,
    flipX:    b.flipX,
    zOrder:   b.zOrder,
    rotation: b.rotation,
    scaleX:   b.scaleX,
    scaleY:   b.scaleY,
  };
}

/** Bindings as written to `.tao` / `.taoeditor`, keyed by bone slot id. */
export function serializeBindings(
  bindings: ReadonlyMap<string, SpriteBinding>,
): Record<string, SpriteBinding> {
  const out: Record<string, SpriteBinding> = {};
  bindings.forEach((b, id) => { out[id] = serializeBinding(b); });
  return out;
}
