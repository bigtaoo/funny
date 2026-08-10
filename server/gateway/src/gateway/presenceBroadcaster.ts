// gateway/Gateway.ts split (2026-08-10, ≤500-line convention, composition layer #2): friend online/offline
// broadcast (SOC9). Depends only on the narrow `ConnLookup`/`Push` surface from connRegistry — never touches
// the WS handshake/heartbeat internals — plus meta/socialsvc for friend-edge lookups.
import type { MetaClient } from '../metaClient';
import type { SocialsvcClient } from '../socialsvcClient';
import type { ConnLookup, Push } from './types';

export interface PresenceBroadcasterDeps {
  conns: ConnLookup;
  push: Push;
  meta: MetaClient;
  socialsvc?: SocialsvcClient;
}

export class PresenceBroadcaster {
  /** Friends-list cache (accountId → friend accountId[]); invalidated by friend changes via /gw/social/invalidate. */
  private readonly friendsCache = new Map<string, string[]>();
  /** publicId cache (accountId → publicId); reused for presence broadcasts to avoid querying meta on every event. */
  private readonly publicIdCache = new Map<string, string>();

  constructor(private readonly deps: PresenceBroadcasterDeps) {}

  /** Friend relationship changed (notified by meta) → clear cache; re-fetched on next broadcast/query. */
  invalidateFriends(accountId: string): void {
    this.friendsCache.delete(accountId);
  }

  /** Connect path: notify online friends that I came online + push me a snapshot of online friends. */
  async notifyOnline(accountId: string): Promise<void> {
    await this.broadcastPresence(accountId, true);
  }

  /** Disconnect path: notify online friends that I went offline, then drop this account's cache entries
   *  (only AFTER the broadcast finishes — it needs them to know who to notify — without this, both caches,
   *  fallback-path-only when socialsvc is down, grow for the life of the process, one entry per account ever seen, never evicted). */
  async notifyOffline(accountId: string): Promise<void> {
    await this.broadcastPresence(accountId, false).finally(() => {
      this.friendsCache.delete(accountId);
      this.publicIdCache.delete(accountId);
    });
  }

  private async friendsOf(accountId: string): Promise<string[]> {
    const cached = this.friendsCache.get(accountId);
    if (cached) return cached;
    const friends = await this.deps.meta.getFriends(accountId);
    this.friendsCache.set(accountId, friends);
    return friends;
  }

  private async publicIdOf(accountId: string): Promise<string> {
    const cached = this.publicIdCache.get(accountId);
    if (cached !== undefined) return cached;
    const p = await this.deps.meta.getProfile(accountId);
    const pid = p.publicId ?? '';
    this.publicIdCache.set(accountId, pid);
    return pid;
  }

  /**
   * Online/offline broadcast: pushes my friend_presence to friends who are currently online;
   * on connect, also sends me a snapshot of currently online friends.
   * P3: if socialsvc is configured, delegates fan-out to socialsvc (friend data is authoritative in nw_social).
   * Fallback: when socialsvc is not configured, broadcasts directly using meta.getFriends (friend data in metaserver).
   */
  private async broadcastPresence(accountId: string, online: boolean): Promise<void> {
    if (this.deps.socialsvc?.available) {
      // P3 path: gateway only fires the event; socialsvc looks up friend edges in nw_social and handles fan-out
      if (online) {
        await this.deps.socialsvc.notifyOnline(accountId);
      } else {
        await this.deps.socialsvc.notifyOffline(accountId);
      }
      return;
    }
    // Fallback path: socialsvc not configured; gateway broadcasts directly using meta's friend list
    if (!this.deps.meta.available) return;
    const [friends, myPid] = await Promise.all([
      this.friendsOf(accountId),
      this.publicIdOf(accountId),
    ]);
    if (!myPid) return;
    for (const fid of friends) {
      const fConn = this.deps.conns.get(fid);
      if (!fConn || fConn.ws.readyState !== fConn.ws.OPEN) continue;
      this.deps.push(fid, { kind: 'friend_presence', publicId: myPid, online });
      // On connect, reflect back: send that online friend's presence to me who just came online (on disconnect I'm already gone, no need to reflect).
      if (online) {
        const fPid = await this.publicIdOf(fid);
        if (fPid) this.deps.push(accountId, { kind: 'friend_presence', publicId: fPid, online: true });
      }
    }
  }
}
