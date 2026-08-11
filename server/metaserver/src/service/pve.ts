// PvE server authority (PVE_INTEGRITY_PLAN §8) + stamina system (A4).
// progress/stars/materials are written ONLY here (and in ranked settlement) — putSave does not
// accept them (trust boundary, §8.3). `pveUpgrades` is legacy-read-only (comparison target for the
// L0 anomaly check in clear.ts): the endpoint that ever wrote it (/pve/upgrade, per-stat upgrades) was
// removed 2026-07-30 (comm-audit-p2-remaining, dead since CC-1 moved unit progression to per-card
// Hero Roster / cardInv) — no accounts can gain new pveUpgrades levels anymore.
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md's "拆分形态的优先级"
// 形态②): holds `core: MetaCore` — assembled by composition in ../service.ts. Each handler hands
// `this.core` straight through to a free function living in ./pve/*.ts (2026-08-11 ctx-bind cleanup —
// see base.ts's header: the bound-`ctx`-object shape this used to build was forced by
// MetaServiceBase's `protected` visibility, 2026-08-10 split; MetaCore's members are plain public
// methods now, so every ./pve/*.ts handler just takes `core: MetaCore` and calls `core.mutateSave(...)`
// etc. directly — no bind, no ctx object). Two of the original private helpers
// (`bumpPveRewardCap`/`deductStamina`/`grantChapterClearCard`/`prepareClearReward`) turned out to only
// ever touch `deps` fields, not a bound method — those are plain deps-parameterized functions with no
// ctx needed at all (pve/helpers.ts).
// - pve/helpers.ts:  shared pure transforms + deps-only helpers (stamina/clear/verify all import from here)
// - pve/stamina.ts:  pveEnter + purchaseStamina (A4)
// - pve/clear.ts:    pveClear + the L1 spot-check decision (§8.6)
// - pve/verify.ts:   pveVerify — L1 replay re-simulation settlement (§8.6)
import type { MetaHandlers } from '../generated/routes.gen.js';
import { type MetaCore } from './base.js';
import { pveEnterHandler, purchaseStaminaHandler } from './pve/stamina.js';
import { pveClearHandler } from './pve/clear.js';
import { pveVerifyHandler } from './pve/verify.js';

type PveHandlers = Pick<MetaHandlers, 'purchaseStamina' | 'pveEnter' | 'pveClear' | 'pveVerify'>;

export class PveService {
  constructor(private readonly core: MetaCore) {}

    async pveEnter(...args: Parameters<PveHandlers['pveEnter']>) {
      return pveEnterHandler(this.core, ...args);
    }

    async purchaseStamina(...args: Parameters<PveHandlers['purchaseStamina']>) {
      return purchaseStaminaHandler(this.core.deps, ...args);
    }

    async pveClear(...args: Parameters<PveHandlers['pveClear']>) {
      return pveClearHandler(this.core, ...args);
    }

    async pveVerify(...args: Parameters<PveHandlers['pveVerify']>) {
      return pveVerifyHandler(this.core, ...args);
    }
}
