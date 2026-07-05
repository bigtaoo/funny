// LobbyScene — main menu / hub (S2). Thin assembly file.
//
// The scene is split by domain — each part lives in ./LobbyScene/*.ts and is composed via the mixin
// chain below over LobbySceneBase (./LobbyScene/base.ts, which owns all instance state + the Scene
// interface + the shared render primitives). To add a handler: find the matching domain mixin (or add
// a new one to the chain) — do NOT grow this file. LobbySceneCallbacks is re-exported so existing
// importers (`from './LobbyScene'`) keep resolving to this file, not the directory.
import { Scene } from './SceneManager';
import { LobbySceneBase } from './LobbyScene/base';
import { BuildMixin } from './LobbyScene/build';
import { BadgesMixin } from './LobbyScene/badges';
import { OverlaysMixin } from './LobbyScene/overlays';

export type { LobbySceneCallbacks } from './LobbyScene/base';

const Assembled = BuildMixin(
  BadgesMixin(
    OverlaysMixin(LobbySceneBase),
  ),
);

/**
 * LobbyScene — the main hub scene registered against SceneManager.
 * Assembled from the per-domain mixin chain over LobbySceneBase.
 */
export class LobbyScene extends Assembled implements Scene {}
