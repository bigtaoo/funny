// Shared e2e harness for socialsvc: real Mongo (mongodb-memory-server via globalSetup) +
// in-memory fakes for the two external dependencies (metaserver profiles, gateway pushes).
import { createSocialMongo, type SocialMongo } from '../src/db';
import type { SocialMetaClient } from '../src/metaClient';
import type { SocialGatewayClient, SocialPushMsg } from '../src/gatewayClient';
import type { ProfileView } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017';

export async function tryConnect(db: string): Promise<SocialMongo | null> {
  try {
    const m = await createSocialMongo(URI, db);
    // Force a real round-trip so an unreachable DB skips the suite instead of hanging later.
    await m.collections.families.estimatedDocumentCount();
    return m;
  } catch {
    return null;
  }
}

/**
 * In-memory SocialMetaClient. Register accounts with `add(accountId, publicId, displayName)`;
 * both `resolveByPublicId` (publicId→account) and `batchProfiles` (account→profile) read the
 * same registry, mirroring metaserver's two internal endpoints.
 */
export class FakeMeta implements SocialMetaClient {
  readonly available = true;
  private readonly byAccount = new Map<string, ProfileView>();
  private readonly byPublicId = new Map<string, string>(); // publicId → accountId

  add(accountId: string, publicId: string, displayName = publicId, rank?: string, equippedTitle?: string): this {
    const profile: ProfileView = { publicId, displayName, ...(rank ? { rank } : {}), ...(equippedTitle ? { equippedTitle } : {}) };
    this.byAccount.set(accountId, profile);
    this.byPublicId.set(publicId, accountId);
    return this;
  }

  async resolveByPublicId(publicId: string): Promise<{ accountId: string; profile: ProfileView } | null> {
    const accountId = this.byPublicId.get(publicId);
    if (!accountId) return null;
    return { accountId, profile: this.byAccount.get(accountId)! };
  }

  async batchProfiles(accountIds: string[]): Promise<Map<string, ProfileView>> {
    const out = new Map<string, ProfileView>();
    for (const id of accountIds) {
      const p = this.byAccount.get(id);
      if (p) out.set(id, p);
    }
    return out;
  }

  async getPlayerRank(accountId: string): Promise<{ rank?: string; elo?: number } | null> {
    const p = this.byAccount.get(accountId);
    if (!p) return null;
    return { ...(p.rank ? { rank: p.rank } : {}) };
  }
}

/** Recording SocialGatewayClient. Captures every push/pushMany; presence is configurable. */
export class FakeGateway implements SocialGatewayClient {
  readonly available = true;
  readonly pushes: { accountId: string; msg: SocialPushMsg }[] = [];
  readonly invalidated: string[] = [];
  presenceMap: Record<string, boolean> = {};

  async push(accountId: string, msg: SocialPushMsg): Promise<void> {
    this.pushes.push({ accountId, msg });
  }
  async pushMany(accountIds: string[], msg: SocialPushMsg): Promise<void> {
    for (const accountId of accountIds) this.pushes.push({ accountId, msg });
  }
  async presence(accountIds: string[]): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const id of accountIds) out[id] = this.presenceMap[id] ?? false;
    return out;
  }
  async invalidateFriends(accountId: string): Promise<void> {
    this.invalidated.push(accountId);
  }

  /** All pushes of a given kind (typed narrow via the discriminant). */
  ofKind<K extends SocialPushMsg['kind']>(kind: K): Extract<SocialPushMsg, { kind: K }>[] {
    return this.pushes.filter((p) => p.msg.kind === kind).map((p) => p.msg) as Extract<SocialPushMsg, { kind: K }>[];
  }
}
