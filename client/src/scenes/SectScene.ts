// SectScene — SLG sect management scene (S8-4b, C6). Thin assembly file.
//
// The scene is split by domain — each part lives in ./SectScene/*.ts and is composed via the mixin
// chain below over SectSceneBase (./SectScene/base.ts, which owns all instance state + the layer
// scaffold + static header + permission getters + render dispatcher + shared close-modal/toast/error
// primitives + input/lifecycle). To add a handler: find the matching domain mixin (data / render /
// input / actions / modals) or add a new one to the chain — do NOT grow this file. SectSceneCallbacks /
// SectSceneView are re-exported so existing importers (`from './SectScene'`) keep resolving to this
// file, not the directory.
import type { Scene } from './SceneManager';
import { SectSceneBase } from './SectScene/base';
import { DataMixin } from './SectScene/data';
import { RenderMixin } from './SectScene/render';
import { InputMixin } from './SectScene/input';
import { ActionsMixin } from './SectScene/actions';
import { ModalsMixin } from './SectScene/modals';

export type { SectSceneCallbacks, SectSceneView } from './SectScene/base';

const Assembled = ModalsMixin(
  ActionsMixin(
    InputMixin(
      RenderMixin(
        DataMixin(SectSceneBase),
      ),
    ),
  ),
);

/**
 * SectScene — the SLG sect management scene registered against SceneManager.
 * Assembled from the per-domain mixin chain over SectSceneBase.
 */
export class SectScene extends Assembled implements Scene {}
