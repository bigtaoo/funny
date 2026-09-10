// Cumulative recharge milestone table — client view over the server-authoritative table
// (GACHA_DESIGN §13 / ADR-045), consumed by RechargeScene.
//
// This file used to be a hand-copied mirror of server/shared/src/rechargeMilestone.ts, with a
// header that asked for the table to be kept "byte-identical to the server table". It no longer
// is: `rechargeMilestone.ts` has zero imports, so it is browser-safe on its own and is aliased as
// `@nw/shared/rechargeMilestone` (webpack / tsconfig / every vitest config) — same treatment as
// cards.ts / equipment.ts / battlepass.ts (ADR-087). The nine tiers were verified byte-identical
// before this copy was deleted.
//
// `findRechargeTier` is deliberately NOT re-exported: the client never looked it up by id (the
// scene renders the whole table), so the copy here had zero call sites and zero test coverage —
// the server's own claim path is its only caller. Claim outcomes stay server-authoritative
// (claimRechargeReward is not re-exported either); this table only feeds the preview.

export type { RechargeReward, RechargeRewardKind, RechargeTierDef } from '@nw/shared/rechargeMilestone';
export {
  /** Nine cumulative-spend tiers, ascending by thresholdCents. */
  RECHARGE_TIERS,
} from '@nw/shared/rechargeMilestone';
