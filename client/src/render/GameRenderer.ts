// GameRenderer — purely visual + InputManager-driven battle renderer. Thin assembly file.
//
// The renderer is split by domain — each part lives in ./GameRenderer/*.ts and is composed via the
// mixin chain below over GameRendererBase (./GameRenderer/base.ts, which owns all instance state +
// the scene-graph builder + the update/destroy lifecycle). To add a handler: find the matching domain
// mixin (input drag/tap-select in ./GameRenderer/input.ts, event/VFX dispatch in
// ./GameRenderer/events.ts) — do NOT grow this file. GameProfiles is re-exported so existing importers
// (`from './GameRenderer'`) keep resolving to this file, not the directory.
import { GameRendererBase } from './GameRenderer/base';
import { InputMixin } from './GameRenderer/input';
import { EventMixin } from './GameRenderer/events';

export type { GameProfiles } from './GameRenderer/base';

const Assembled = EventMixin(InputMixin(GameRendererBase));

/**
 * GameRenderer — the battle scene renderer. Assembled from the per-domain
 * mixin chain over GameRendererBase.
 */
export class GameRenderer extends Assembled {}
