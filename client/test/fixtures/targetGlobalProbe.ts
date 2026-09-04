// Compile fixture for targetGlobalCompile.test.ts.
//
// Two exports, because they answer two different questions and the first one alone was not enough:
//   `raw`  — the expression the three readers spell out, proving DefinePlugin substitutes a member
//            expression on globalThis at all.
//   `viaAppConstants` — the real shipped function, so the probe cannot pass on a copy of the read
//            while the actual reader has been rewritten to something the config no longer covers.
// No other imports, so the emitted bundle can be require()'d in Node and asked what it sees.
import { clientPlatformName } from '../../src/app/appConstants';

export const raw = (globalThis as { TARGET?: string }).TARGET ?? 'NOT-SUBSTITUTED';
export const viaAppConstants = clientPlatformName();
