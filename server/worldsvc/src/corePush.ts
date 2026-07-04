// worldsvc core — scheduling infra & real-time push (WorldCore split, 2026-07-03).
// Best-effort Redis ZSETs for precise march/siege-damage wake-ups (Mongo scan stays
// authoritative) plus the gateway push helpers. No behavior change.
import { WorldCoreYield } from './coreYield';
import type { MarchView } from './worldTypes';
import type { SiegeDoc, TileDoc } from './db';

export class WorldCorePush extends WorldCoreYield {
  // ── Redis scheduling (best-effort, §14.4 `world:{worldId}:march` ZSET, score=arriveAt) ──
  // Processing uses the Mongo arriveAt scan as authoritative; the ZSET is only for future precise wake-ups; silently skipped when Redis is absent.
  private marchZsetKey(worldId: string): string {
    return `world:${worldId}:march`;
  }
  async scheduleMarch(worldId: string, mid: string, arriveAt: number): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zadd(this.marchZsetKey(worldId), arriveAt, mid);
    } catch {
      /* best-effort: failure only loses the precise wake-up; the Mongo scan still processes arrivals */
    }
  }
  async unscheduleMarch(worldId: string, mid: string): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zrem(this.marchZsetKey(worldId), mid);
    } catch {
      /* best-effort */
    }
  }

  // ── ADR-026: delayed building-HP settlement scheduling (best-effort ZSET, score=dueAt; Mongo dueAt scan is authoritative) ──
  private siegeDamageZsetKey(worldId: string): string {
    return `world:${worldId}:siegeDamage`;
  }
  async scheduleSiegeDamage(worldId: string, id: string, dueAt: number): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zadd(this.siegeDamageZsetKey(worldId), dueAt, id);
    } catch {
      /* best-effort: failure only loses the precise wake-up; the Mongo dueAt scan still settles the hit */
    }
  }
  async unscheduleSiegeDamage(worldId: string, id: string): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zrem(this.siegeDamageZsetKey(worldId), id);
    } catch {
      /* best-effort */
    }
  }

  // ── Real-time push (best-effort, §14.5) ──
  async pushMarch(accountId: string, v: MarchView): Promise<void> {
    await this.gateway.push(accountId, {
      kind: 'march_update',
      marchId: v.marchId,
      marchKind: v.kind,
      fromTile: v.fromTile,
      toTile: v.toTile,
      arriveAt: v.arriveAt,
      status: v.status,
    });
  }
  async pushTile(accountId: string, t: TileDoc): Promise<void> {
    const ownerProfile = (t.ownerId && this.meta.available)
      ? await this.meta.getProfile(t.ownerId).catch(() => null)
      : null;
    await this.gateway.push(accountId, {
      kind: 'tile_update',
      tileId: t._id,
      type: t.type,
      level: t.level,
      ownerPublicId: ownerProfile?.publicId ?? '',
      ownerName: ownerProfile?.displayName ?? '',
      familyId: t.familyId ?? '',
      protectedUntil: t.protectedUntil ?? 0,
    });
  }
  async pushSiege(accountId: string, s: SiegeDoc, lootSummaryStr: string): Promise<void> {
    await this.gateway.push(accountId, {
      kind: 'siege_result',
      siegeId: s._id,
      tile: s.tile,
      outcome: s.outcome,
      lootSummary: lootSummaryStr,
      replayRef: s.replayRef ?? '',
    });
  }
}
