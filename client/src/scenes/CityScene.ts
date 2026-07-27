// CityScene — Home-city management scene. Thin assembly file.
//
// SLG_CITY_DESIGN P1 + P3 D-CITY-8/10/12. Entry: WorldMapScene taps own base tile → "Enter Desk".
// The scene is split by domain — each part lives in ./CityScene/*.ts and is composed via the mixin
// chain below over CitySceneBase (./CityScene/base.ts, which owns all instance state + data loading +
// icon resolution + network actions + the render dispatcher + input/lifecycle). To add a renderer or
// modal: find the matching domain mixin (render / modals) or add a new one to the chain — do NOT grow
// this file. CitySceneCallbacks is re-exported so existing importers (`from './CityScene'`) keep
// resolving to this file, not the directory.
import type { Scene } from './SceneManager';
import { CitySceneBase } from './CityScene/base';
import { RenderMixin } from './CityScene/render';
import { ModalsMixin } from './CityScene/modals';

export type { CitySceneCallbacks } from './CityScene/base';

const Assembled = ModalsMixin(RenderMixin(CitySceneBase));

/**
 * CityScene — the home-city management scene registered against SceneManager.
 * Assembled from the per-domain mixin chain over CitySceneBase.
 */
export class CityScene extends Assembled implements Scene {}
