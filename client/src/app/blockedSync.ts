// Wires ui/moderation.ts (App Review 1.2 report / block / blocked list) to this app's ApiClient, and
// keeps its blocked-players store scoped to the signed-in account. Kept out of createAppCore so the
// nav modules (lobby / social / world) can call the sync without importing the core.
import type { ApiClient } from '../net/ApiClient';
import type { IStorage } from '../platform/IPlatform';
import { setModerationBackend, syncBlockedPlayers } from '../ui/moderation';
import { PLAYER_PUBLIC_ID_KEY } from './appConstants';

/** Register the report/block endpoints (no-op offline: without an API nothing is offered). */
export function installModerationBackend(api: ApiClient | undefined, storage: IStorage): void {
  if (!api) { setModerationBackend(null); return; }
  setModerationBackend({
    report: (publicId, ctx) => api.reportUser(publicId, ctx),
    block: (publicId, ctx) => api.blockUser(publicId, ctx),
    unblock: (publicId) => api.unblockUser(publicId),
    listBlocked: () => api.getBlockedUsers(),
    selfPublicId: () => storage.getItem(PLAYER_PUBLIC_ID_KEY) ?? '',
  });
}

/**
 * Load the blocked list for the signed-in account unless it already is (cheap to call on every
 * social entry). Keyed on the account's publicId, so an account switch reloads — logout also resets
 * it outright (nav/auth.ts). Skipped without a session: the endpoint needs the token.
 */
export function syncBlockedForSession(api: ApiClient | undefined, storage: IStorage): void {
  const publicId = storage.getItem(PLAYER_PUBLIC_ID_KEY);
  // Optional call: nav tests hand in partial ApiClient stubs, and a missing sync must never break navigation.
  if (!api || !publicId || !api.hasToken?.()) return;
  void syncBlockedPlayers(publicId);
}
