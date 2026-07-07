// FamilyScene — SLG family management scene (S8-4). Thin assembly file.
//
// State machine: noFamily → search/create branch; myFamily → channel/members.
// The scene is split by domain — each part lives in ./FamilyScene/*.ts and is composed via the mixin
// chain below over FamilySceneBase (./FamilyScene/base.ts, which owns all instance state + the layer
// scaffold + render dispatcher + shared confirm-modal/toast/error primitives + input/lifecycle). To add
// a handler: find the matching domain mixin (data / render / input / actions) or add a new one to the
// chain — do NOT grow this file. FamilySceneCallbacks is re-exported so existing importers
// (`from './FamilyScene'`) keep resolving to this file, not the directory.
import type { Scene } from './SceneManager';
import { FamilySceneBase } from './FamilyScene/base';
import { DataMixin } from './FamilyScene/data';
import { RenderMixin } from './FamilyScene/render';
import { InputMixin } from './FamilyScene/input';
import { ActionsMixin } from './FamilyScene/actions';

export type { FamilySceneCallbacks } from './FamilyScene/base';

const Assembled = ActionsMixin(
  InputMixin(
    RenderMixin(
      DataMixin(FamilySceneBase),
    ),
  ),
);

/**
 * FamilyScene — the SLG family management scene registered against SceneManager.
 * Assembled from the per-domain mixin chain over FamilySceneBase.
 */
export class FamilyScene extends Assembled implements Scene {}
