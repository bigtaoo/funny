// worldsvc → gateway internal push (S8-2). SLG real-time events (march status / tile changes)
// are delivered to the owner accountId via gateway /gw/push (same SOC3 principle as social:
// actions over REST, events over push).
// Internal auth: X-Internal-Key (shared NW_INTERNAL_KEY). If gateway base URL is not configured,
// push is a no-op (worldsvc degrades: clients poll /world/me and /world/map for state).
// Mirrors the meta gatewayClient in shape.
//
// Note: SlgPushMsg kind/fields on the worldsvc side must match the SLG branch of
// gateway matchsvcClient.PushMsg character-for-character (JSON wire contract, camelCase discriminator=kind).
import { GW_PUSH_REDIS_CHANNEL, postInternal } from '@nw/shared';

export type SlgPushMsg =
  | {
      kind: 'march_update';
      marchId: string;
      marchKind: string; // attack | reinforce | occupy | sweep | return
      fromTile: string;
      toTile: string;
      arriveAt: number; // ms
      status: string; // marching | arrived | recalled
    }
  | {
      kind: 'tile_update';
      tileId: string;
      type: string; // TileType
      level: number;
      ownerPublicId: string; // occupier's 9-digit public id (empty = neutral)
      ownerName: string;     // occupier's display name (empty when meta is unavailable)
      familyId: string;
      protectedUntil: number; // ms (0 = no protection)
    }
  | {
      kind: 'under_attack'; // S8-3: pushed to the defender as soon as a march is launched (early warning: arrival time + troop estimate)
      tile: string;
      attackerName: string; // attacker identifier; S8-3 temporarily uses accountId; publicId resolution to be added later
      attackerPublicId: string;
      arriveAt: number; // ms
      troopsHint: number;
    }
  | {
      kind: 'siege_result'; // S8-3: pushed to both attacker and defender after siege settlement
      siegeId: string;
      tile: string;
      outcome: string; // attacker_win | defender_win | draw
      lootSummary: string; // human-readable summary (e.g. "ink+250"), displayed directly in UI
      replayRef: string; // replay reference (filled after S8-3b judge replay; currently empty)
    }
  | {
      kind: 'family_msg'; // S8-4: new message in the family channel (pushed only to online members)
      familyId: string;
      fromPublicId: string; // S8-4 temporarily uses accountId; publicId resolution to be added later
      fromName: string;
      body: string;
      ts: number; // ms (epoch, not Date)
    }
  | {
      kind: 'sect_msg'; // S8-4b: new message in the sect channel (fan-out to online members via Redis)
      sectId: string;
      fromPublicId: string; // temporarily uses accountId; publicId resolution to be added later
      fromName: string;
      body: string;
      ts: number; // ms (epoch, not Date)
    }
  | {
      kind: 'nation_msg'; // B7: new message in the nation/world public channel (fan-out via Redis to online players in the same world)
      worldId: string;
      fromPublicId: string;
      fromName: string;
      body: string;
      ts: number; // ms (epoch, not Date)
    };

export interface WorldGatewayClient {
  readonly available: boolean;
  /** Pushes one SLG event to a specific accountId (offline / gateway not configured → discarded). Best-effort, does not throw. */
  push(accountId: string, msg: SlgPushMsg): Promise<void>;
  /**
   * Broadcasts one SLG event to a batch of recipients (S8-4b sect channel). When Redis is
   * available, publishes a single message to GW_PUSH_REDIS_CHANNEL; each gateway instance
   * then fans out to its online members (avoids O(n) HTTP for ≤900 recipients). Without Redis,
   * falls back to individual HTTP pushes per recipient. Best-effort, does not throw.
   */
  broadcast(recipients: string[], msg: SlgPushMsg): Promise<void>;
}
// Note: after G3-2b, critical sieges are resolved by worldsvc directly importing @nw/engine headless
// for authoritative results (§16.8); the gateway replay judge replay path is no longer used.
// The original worldsvc→gateway `judge()` client (S8-3b) was deleted along with the manual-control approach.

/** Minimal Redis interface required by broadcast (publish only); compatible with the WorldRedis shape in worldsvc/redis.ts. */
export interface BroadcastRedis {
  publish(channel: string, message: string): Promise<unknown>;
}

export class HttpWorldGatewayClient implements WorldGatewayClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
    /** Optional Redis: used for sect-channel fan-out (omitted → broadcast degrades to per-recipient HTTP push). */
    private readonly redis: BroadcastRedis | null = null,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async broadcast(recipients: string[], msg: SlgPushMsg): Promise<void> {
    if (recipients.length === 0) return;
    if (this.redis) {
      try {
        await this.redis.publish(GW_PUSH_REDIS_CHANNEL, JSON.stringify({ recipients, msg }));
        return;
      } catch {
        // Redis publish failed → fall through to HTTP fallback (does not throw; channel is persisted in DB and can be fetched via REST).
      }
    }
    await Promise.allSettled(recipients.map((r) => this.push(r, msg)));
  }

  async push(accountId: string, msg: SlgPushMsg): Promise<void> {
    if (!this.baseUrl) return;
    // best-effort, self-healing (authoritative state is in DB; client re-polls) →
    // retries=0. The win is body-drain + timeout (a siege fanout is a burst).
    await postInternal(`${this.baseUrl}/gw/push`, { accountId, msg }, {
      caller: 'worldsvc',
      key: this.internalKey,
      label: `/gw/push ${msg.kind}`,
    });
  }
}

/** Null implementation for tests or when no gateway is configured. */
export const nullWorldGatewayClient: WorldGatewayClient = {
  available: false,
  async push() { /* no-op */ },
  async broadcast() { /* no-op */ },
};
