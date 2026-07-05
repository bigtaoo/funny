// Admin service core (OPS_DESIGN §2/§3/§5). RBAC + account management + compensation approval ticket flow + audit + monitoring/trends + sampling.
// httpApi handles authentication (admin JWT) + static capability gates; this class enforces business invariants (initiator ≠ approver, quota → approval capability,
// ticket state machine) + audit persistence. All write operations flow through here → single source of truth.
//
// The class is split by business domain — each mixin lives in ./service/*.ts and shares the cross-cutting
// helpers (audit / actorNames / requireCap) + the login-attempt table defined on AdminServiceBase
// (./service/base.ts). To add a handler: find the matching domain mixin (or add a new one to the chain
// below) — do NOT grow this file.
import { ADMIN_ROLES } from '@nw/shared';
import { AdminServiceBase } from './service/base';
import { EventsMixin } from './service/events';
import { GachaMixin } from './service/gacha';
import { PromoMixin } from './service/promo';
import { LadderMixin } from './service/ladder';
import { WorldMixin } from './service/world';
import { MapTemplatesMixin } from './service/mapTemplates';
import { SlgAuditMixin } from './service/slgAudit';
import { AuthMixin } from './service/auth';
import { AccountsMixin } from './service/accounts';
import { TicketsMixin } from './service/tickets';
import { AnalyticsMixin } from './service/analytics';
import { FlagsMixin } from './service/flags';

export { AdminError } from './service/errors';
export type { Actor, AdminServiceDeps } from './service/base';
export { ADMIN_ROLES };

const Assembled = FlagsMixin(
  AnalyticsMixin(
    TicketsMixin(
      AccountsMixin(
        AuthMixin(
          SlgAuditMixin(
            MapTemplatesMixin(
              WorldMixin(
                LadderMixin(
                  PromoMixin(
                    GachaMixin(
                      EventsMixin(AdminServiceBase),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
);

/**
 * AdminService — the single object registered against every admin route (httpApi calls svc.method(...)).
 * Assembled from the per-domain mixin chain over AdminServiceBase.
 */
export class AdminService extends Assembled {}
