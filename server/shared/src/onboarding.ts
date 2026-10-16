// Onboarding constants shared by metaserver (which pays them) and the client (which promises them).
// Zero-import on purpose: the client consumes this file directly through the `@nw/shared/onboarding`
// alias (same treatment as titles.ts / battlepass.ts — see client/webpack.config.js).

/**
 * Coins attached to the author's welcome mail, sent once on an account's first-ever level clear
 * (ONBOARDING_DESIGN §5.1). The tutorial's graduation card announces it as the first-win reward
 * (§11.6), so both sides must read this one number.
 */
export const WELCOME_MAIL_COINS = 1000;

/**
 * Next-day hero gift (ONBOARDING_DESIGN §17.4): the first clear of this level — where the hero joins the
 * fight as a trial card — earns this hero card for keeps, claimable from the next UTC midnight on. A reason
 * to come back tomorrow, announced in the battle, on the chain banner and in the lobby. Moved from ch1_lv5
 * to ch1_lv3 on 2026-10-16 (§17.9): few CG sessions got as far as lv5.
 */
export const HERO_GIFT_LEVEL_ID = 'ch1_lv3';
export const HERO_GIFT_DEF_ID = 'max';

const DAY_MS = 86_400_000;

/** When a gift earned at `ts` (epoch ms) becomes claimable: the next UTC midnight. */
export function heroGiftClaimableAt(ts: number): number {
  return (Math.floor(ts / DAY_MS) + 1) * DAY_MS;
}
