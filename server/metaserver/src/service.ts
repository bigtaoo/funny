// metaserver serviceHandlers: operationId from openapi.yml → method (assembled via generated/routes.gen.ts).
// Validation/routing is handled by the codegen'd router according to the spec; this file only assembles the
// per-domain handler mixins into a single MetaService that structurally satisfies MetaHandlers.
//
// The class is split by business domain — each mixin lives in ./service/*.ts and shares the cross-cutting
// helpers (mutateSave / ensureCommercial / gatewayField / rejectIfBanned / readStaminaSnapshot /
// bumpRetentionTask) defined on MetaServiceBase (./service/base.ts). To add a handler: find the matching
// domain mixin (or add a new one to the chain below) — do NOT grow this file.
import type { MetaHandlers } from './generated/routes.gen.js';
import { MetaServiceBase } from './service/base.js';
import { AuthMixin } from './service/auth.js';
import { SaveMixin } from './service/save.js';
import { PveMixin } from './service/pve.js';
import { EconomyMixin } from './service/economy.js';
import { InventoryMixin } from './service/inventory.js';
import { ProgressionMixin } from './service/progression.js';
import { LiveOpsMixin } from './service/liveops.js';
import { SocialMixin } from './service/social.js';
import { TelemetryMixin } from './service/telemetry.js';

export type { ServiceDeps } from './service/base.js';

const Assembled = TelemetryMixin(
  SocialMixin(
    LiveOpsMixin(
      ProgressionMixin(
        InventoryMixin(
          EconomyMixin(
            PveMixin(
              SaveMixin(
                AuthMixin(MetaServiceBase),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
);

/**
 * MetaService — the single object registered against every REST route (registerRoutes calls
 * fn.call(service, req, reply)). `implements MetaHandlers` gives a localized compile-time guarantee
 * that all handler methods are present on the assembled mixin chain.
 */
export class MetaService extends Assembled implements MetaHandlers {}
