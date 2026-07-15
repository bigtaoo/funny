// metaserver REST client (S0-5). Covers the endpoints used by S0: auth/device · auth/wx · GET/PUT save,
// plus economy/social/achievements/events/retention/season/bootstrap. Thin assembly file.
//
// The client is split by domain — each part lives in ./ApiClient/*.ts and is composed via the mixin
// chain below over ApiClientBase (./ApiClient/base.ts, which owns the constructor + auth token + the
// shared request()/fetchRaw() transport). To add an endpoint: find the matching domain mixin
// (auth / pve / equipment / shop / gacha / social / mail / achievements / misc) or add a new one to the
// chain — do NOT grow this file. All DTO/view types + ApiError are re-exported so existing importers
// (`from '../net/ApiClient'`) keep resolving to this file, not the directory.
//
// Contract = contracts/openapi.yml (unified response envelope ApiResp<T>, optimistic locking via If-Match).
import { ApiClientBase } from './ApiClient/base';
import { AuthMixin } from './ApiClient/auth';
import { PveMixin } from './ApiClient/pve';
import { EquipmentMixin } from './ApiClient/equipment';
import { ShopMixin } from './ApiClient/shop';
import { GachaMixin } from './ApiClient/gacha';
import { SocialMixin } from './ApiClient/social';
import { MailMixin } from './ApiClient/mail';
import { AchievementsMixin } from './ApiClient/achievements';
import { MiscMixin } from './ApiClient/misc';

export { ApiError } from './ApiClient/base';
export type {
  ShopItem,
  GachaPool,
  GachaResultEntry,
  MatchHistoryEntry,
  AuthResult,
  ActiveMatchInfo,
  ProfileView,
  FriendView,
  FriendRequestView,
  ConversationView,
  ChatMessageView,
  MailView,
  MailAttachmentView,
  SocialBadges,
  ServerReplay,
  Achievement,
  AchievementsView,
  EventView,
  RetentionView,
  PushResult,
} from './ApiClient/types';

const Assembled = MiscMixin(
  AchievementsMixin(
    MailMixin(
      SocialMixin(
        GachaMixin(
          ShopMixin(
            EquipmentMixin(
              PveMixin(
                AuthMixin(ApiClientBase),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
);

/**
 * metaserver REST client, assembled from the per-domain mixin chain over ApiClientBase.
 */
export class ApiClient extends Assembled {}
