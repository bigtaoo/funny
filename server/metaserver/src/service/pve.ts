// PvE server authority (PVE_INTEGRITY_PLAN §8) + stamina system (A4) — mixin facade.
// progress/stars/materials are written ONLY here (and in ranked settlement) — putSave does not
// accept them (trust boundary, §8.3). `pveUpgrades` is legacy-read-only (comparison target for the
// L0 anomaly check in clear.ts): the endpoint that ever wrote it (/pve/upgrade, per-stat upgrades) was
// removed 2026-07-30 (comm-audit-p2-remaining, dead since CC-1 moved unit progression to per-card
// Hero Roster / cardInv) — no accounts can gain new pveUpgrades levels anymore.
//
// Split into independent function modules (2026-08-10, 独立函数模块 form, equipment.ts/cards.ts's
// sibling — the "already in the mixin chain but grown fat" case from claudedocs/server.md's priority
// doc: evaluated independent-class-composition first, but every handler needs `this.mutateSave`/
// `this.rejectIfBanned`/`this.readStaminaSnapshot`, all `protected` on MetaServiceBase, so a sibling
// class outside the mixin's own inheritance chain has no structural way to call them (TS rejects
// assigning a `protected` member to any wider/interface-shaped type, from any scope). Free functions
// sidestep this entirely: PveMixin's class body — which DOES have inherited access — reads `this.deps`
// and `.bind(this)`s the handful of protected methods each handler needs into a plain `ctx` object (bound
// functions are ordinary callable values with no visibility modifier of their own), then hands that `ctx`
// to a free function living outside the class. Two of the original private helpers (`bumpPveRewardCap`/
// `deductStamina`/`grantChapterClearCard`/`prepareClearReward`) turned out to only ever touch `this.deps`
// fields, not a protected method — those became plain deps-parameterized functions with no ctx needed at
// all (pve/helpers.ts). No behavior change: every method body was moved verbatim.
// - pve/helpers.ts:  shared pure transforms + deps-only helpers (stamina/clear/verify all import from here)
// - pve/stamina.ts:  pveEnter + purchaseStamina (A4)
// - pve/clear.ts:    pveClear + the L1 spot-check decision (§8.6)
// - pve/verify.ts:   pveVerify — L1 replay re-simulation settlement (§8.6)
import type { MetaHandlers } from '../generated/routes.gen.js';
import { type Constructor, type MetaBaseCtor } from './base.js';
import { pveEnterHandler, purchaseStaminaHandler } from './pve/stamina.js';
import { pveClearHandler } from './pve/clear.js';
import { pveVerifyHandler } from './pve/verify.js';

type PveHandlers = Pick<MetaHandlers, 'purchaseStamina' | 'pveEnter' | 'pveClear' | 'pveVerify'>;

export function PveMixin<TBase extends MetaBaseCtor>(Base: TBase): TBase & Constructor<PveHandlers> {
  return class extends Base {
    async pveEnter(...args: Parameters<PveHandlers['pveEnter']>) {
      return pveEnterHandler({ deps: this.deps, rejectIfBanned: this.rejectIfBanned.bind(this) }, ...args);
    }

    async purchaseStamina(...args: Parameters<PveHandlers['purchaseStamina']>) {
      return purchaseStaminaHandler(this.deps, ...args);
    }

    async pveClear(...args: Parameters<PveHandlers['pveClear']>) {
      return pveClearHandler(
        {
          deps: this.deps,
          rejectIfBanned: this.rejectIfBanned.bind(this),
          mutateSave: this.mutateSave.bind(this),
          readStaminaSnapshot: this.readStaminaSnapshot.bind(this),
        },
        ...args,
      );
    }

    async pveVerify(...args: Parameters<PveHandlers['pveVerify']>) {
      return pveVerifyHandler({ deps: this.deps, mutateSave: this.mutateSave.bind(this) }, ...args);
    }
  };
}
