// FriendsScene — Social Hub (S6-1/S6-2/S6-3/S6-4). Thin assembly file.
//
// The scene is split by domain — each part lives in ./FriendsScene/*.ts and is composed via the mixin
// chain below over FriendsSceneBase (./FriendsScene/base.ts, which owns all instance state + the chrome/
// render dispatcher + shared render primitives). To add a handler: find the matching domain mixin (or add
// a new one to the chain) — do NOT grow this file. SLGSocialStatus / FriendsSceneCallbacks are re-exported
// so existing importers (`from './FriendsScene'`) keep resolving to this file, not the directory.
import { Scene } from './SceneManager';
import { FriendsSceneBase } from './FriendsScene/base';
import { FriendsListMixin } from './FriendsScene/friendsList';
import { SearchMixin } from './FriendsScene/search';
import { OrgFormMixin } from './FriendsScene/orgForm';
import { WorldChatMixin } from './FriendsScene/worldChat';
import { MailMixin } from './FriendsScene/mail';
import { NetworkMixin } from './FriendsScene/service';

export type { SLGSocialStatus, FriendsSceneCallbacks } from './FriendsScene/base';

const Assembled = NetworkMixin(
  MailMixin(
    WorldChatMixin(
      OrgFormMixin(
        SearchMixin(
          FriendsListMixin(FriendsSceneBase),
        ),
      ),
    ),
  ),
);

/**
 * FriendsScene — the social hub scene registered against SceneManager.
 * Assembled from the per-domain mixin chain over FriendsSceneBase.
 */
export class FriendsScene extends Assembled implements Scene {}
