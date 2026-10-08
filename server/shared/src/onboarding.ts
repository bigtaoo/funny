// Onboarding constants shared by metaserver (which pays them) and the client (which promises them).
// Zero-import on purpose: the client consumes this file directly through the `@nw/shared/onboarding`
// alias (same treatment as titles.ts / battlepass.ts — see client/webpack.config.js).

/**
 * Coins attached to the author's welcome mail, sent once on an account's first-ever level clear
 * (ONBOARDING_DESIGN §5.1). The tutorial's graduation card announces it as the first-win reward
 * (§11.6), so both sides must read this one number.
 */
export const WELCOME_MAIL_COINS = 1000;
