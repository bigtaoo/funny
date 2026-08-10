// Account resolution (S0-4 / S0-7) + password accounts (SA-1) + OAuth (SA-2).
// Anonymous device/wx → stable accountId; password register / login / change-password; OAuth login / bind.
//
// ── Split (2026-08-10, independent function module range 6) ──
// This file was already a set of mutually-independent exported functions (no class, no shared
// mutable state beyond each function's own Mongo round trips) grouped by concern — a textbook
// independent-function-module split, by domain: `accounts/{resolve,password,profile,search,
// oauthBind,wxAuth}.ts`. `export *` below re-exports every sibling's public API, same shape as the
// `equipment.ts`/`cards.ts` precedents; external import paths (`from '../accounts.js'`,
// `from '../dist/accounts.js'` in the race e2e test) are unaffected.
export * from './accounts/resolve.js';
export * from './accounts/password.js';
export * from './accounts/profile.js';
export * from './accounts/search.js';
export * from './accounts/oauthBind.js';
export * from './accounts/wxAuth.js';
