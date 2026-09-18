// Single bot session (BOTSVC_DESIGN §3.2): login, family join/leave-on-low-activity, payment-tier
// bootstrap, SLG city actions (§3.2 slg_action), and — this increment — ranked matchmaking + battle
// over a real gateway+gameserver WS connection driven by @nw/engine's AISystem (§1 B3, §8).
import { BUILD_QUEUE_SLOTS, RESOURCE_TYPES, buildCost, buildGateReason } from '@nw/shared';
import { MetaClient } from './metaClient';
import { SocialClient } from './socialClient';
import { CommercialClient } from './commercialClient';
import { WorldClient, type BuildingKey, type PlayerWorldView } from './worldClient';
import { playRankedMatch } from './battleSession';
import type { BotIdentity } from './pool';

/** Below this prosperity, a bot looks for a livelier family instead (mirrors a real player ditching a dead guild). */
const FAMILY_PROSPERITY_LEAVE_THRESHOLD = 10;

/** P1-buildable keys only (BuildingKey's wall/academy are P2, not yet buildable — see contracts/openapi-world.yml). */
const P1_BUILDING_KEYS: BuildingKey[] = [
  'desk',
  'inkPot',
  'paperTray',
  'graphiteMill',
  'metalForge',
  'stickerShop',
  'cabinet',
  'drillYard',
];

/** Every Nth slg tick a bot considers a siege instead of just upgrading — "偶尔攻城", not every tick (BOTSVC_DESIGN §3.2). */
const SIEGE_TICK_INTERVAL = 5;
/** Send a minority of the garrison; never risk the whole troop count on one march. */
const SIEGE_TROOP_FRACTION = 0.3;
/**
 * Upper bound worldsvc puts on any map-view radius (`MAP_VIEW_MAX_RADIUS` in worldsvc/src/worldTypes.ts).
 * Asking for more is not an error — the server silently clamps — so a larger number here would be a lie
 * in the source rather than a wider scan. `bot.scanRadius.test.ts` fails if the two ever drift.
 */
const WORLD_MAP_VIEW_MAX_RADIUS = 40;

/**
 * Sparse-map scan radius around the bot's own base when looking for a siege target.
 *
 * Sits AT the server's view cap, deliberately. 5 was tuned against season 1's crowded shard (1644
 * players, nearest-neighbour base distance p50 = 4) and stopped reaching anything once play moved to a
 * sparse one: measured on live s2-0 on 2026-09-15, 108 players spread over 1500×1500 give p50 = 42 /
 * p90 = 85, and an 11×11 window found a target for **2 of 108** bots. `POST /world/march` was absent
 * from all 288 worldsvc heartbeats of the preceding 24h — no bot had besieged anything at all, and the
 * wasted `/world/me` + `/world/map/sparse` pair every fifth tick fell through to yet another upgrade,
 * which is why `build/upgrade` ran at 5/5 ticks instead of the intended 4/5. At the cap it is 54 of 108.
 */
const SIEGE_SCAN_RADIUS = WORLD_MAP_VIEW_MAX_RADIUS;

/**
 * Wall-clock floor between two SLG upkeep passes *for one bot*, independent of how the scheduler is
 * tuned. `tickSlg()` used to act on every upkeep pass it was handed, so its rate was a side effect of
 * `tickMs × upkeepRotations` (5s × 3 = one pass per bot per 15s) — two knobs that exist to shape the
 * scheduler's CPU burst, not to say how often a bot should touch the world. This decouples them: the
 * scheduler may visit a bot as often as it likes; the bot itself acts at most this often.
 */
export const DEFAULT_SLG_INTERVAL_MS = 45_000;

/**
 * Hard ceiling on how stale the resource snapshot behind the upgrade decision may get. In the default
 * configuration this never fires — a siege tick refreshes the snapshot every SIEGE_TICK_INTERVAL SLG
 * ticks (5 × 45s = 225s) for free, out of the `/world/me` it was fetching anyway. It is the backstop
 * for a configuration where that no longer holds, so that a bot which currently affords nothing still
 * re-checks eventually instead of going quiet forever.
 */
const SLG_SNAPSHOT_TTL_MS = 5 * 60_000;

/** Per-bot SLG pacing (see DEFAULT_SLG_INTERVAL_MS); injected so tests can drive ticks without waiting. */
export interface SlgOptions {
  intervalMs: number;
}

/** Empty deck = server assigns defaultPvpDeck (RoomCreate.deck contract) — bots don't build loadouts. */
const BOT_DECK: string[] = [];
/** Mid-curve difficulty (AISystem.ts DIFFICULTY, L1-L10) — bots aren't meant to feel unbeatable or free wins. */
const BOT_AI_DIFFICULTY = 5;

export type BotState = 'offline' | 'logging_in' | 'lobby_idle' | 'family_task' | 'slg_action' | 'matchmaking' | 'in_battle';

export interface BattleOptions {
  gatewayWsUrl: string;
  /** Probability of entering ranked matchmaking on any given lobby_idle tick. */
  chancePerTick: number;
}

export class BotSession {
  state: BotState = 'offline';
  private token: string | undefined;
  private accountId: string | undefined;
  private gatewayUrl: string | undefined;
  private paymentBootstrapped = false;
  private worldId: string | undefined;
  private slgTick = 0;
  private buildRotation = 0;
  /** Earliest wall-clock time this bot may act in the world again (DEFAULT_SLG_INTERVAL_MS). */
  private nextSlgAt = 0;
  /** Last `/world/me` this session saw, used to decide what it can afford before asking the server. */
  private slgSnapshot: PlayerWorldView | undefined;
  private slgSnapshotAt = 0;
  private battling = false;
  /** Set while a battle is in flight (runBattle) — logout() aborts it instead of leaving the match
   *  running to completion against an account the fleet no longer tracks as online (2026-08-04 fix). */
  private battleAbort: AbortController | undefined;

  constructor(
    readonly identity: BotIdentity,
    private readonly meta: MetaClient,
    private readonly social: SocialClient,
    private readonly commercial: CommercialClient,
    private readonly world: WorldClient,
    private readonly battle: BattleOptions,
    private readonly slg: SlgOptions = { intervalMs: DEFAULT_SLG_INTERVAL_MS },
  ) {}

  async login(): Promise<void> {
    this.state = 'logging_in';
    try {
      const login = await this.meta.deviceLogin(this.identity.deviceId);
      this.token = login.token;
      this.accountId = login.accountId;
      this.gatewayUrl = login.gatewayUrl;
    } catch (e) {
      // 2026-08-04 fix: a failed deviceLogin used to leave state stuck at 'logging_in' forever — the
      // scheduler's spawnUpTo only re-selects sessions with state==='offline', so this session could
      // never be retried, and it still passed spawnUpTo's `state !== 'offline'` check into `online`
      // despite having no token, occupying a fleet slot that never does anything.
      this.state = 'offline';
      throw e;
    }
    if (!this.paymentBootstrapped) {
      // A purchase failing must not keep the bot offline — the account is logged in and can still
      // play. This also lets the fleet run against a backend whose internal commercial port isn't
      // reachable (e.g. an external load-gen fleet dialing only the public API surface).
      try {
        await this.bootstrapPaymentTier();
        this.paymentBootstrapped = true;
      } catch {
        /* purchase unavailable this login; retried next login */
      }
    }
    this.state = 'lobby_idle';
  }

  logout(): void {
    // Cancel any in-flight battle (2026-08-04 fix): without this, a match kept running to completion
    // in the background after logout(), holding a live gateway/gameserver WS connection open for an
    // account the fleet no longer tracks as online — defeating load-shedding (despawnDownTo) entirely.
    this.battleAbort?.abort();
    this.token = undefined;
    this.accountId = undefined;
    this.gatewayUrl = undefined;
    this.state = 'offline';
  }

  /**
   * One matchmaking roll (§3.2): from lobby_idle, a bot occasionally queues for a real ranked match
   * and plays it out over the actual gateway/gameserver WS protocol. Fire-and-forget by design — a
   * match can run for minutes, so this must never be awaited by the scheduler's tick loop (that would
   * serialize every other bot's upkeep behind one match). Errors (disconnect, timeout, matchmaking
   * failure) fall back to lobby_idle rather than crashing the session.
   */
  tickBattle(): void {
    if (this.state !== 'lobby_idle' || this.battling || !this.token) return;
    if (Math.random() >= this.battle.chancePerTick) return;
    this.battling = true;
    this.state = 'matchmaking';
    void this.runBattle()
      .catch((e) => {
        console.warn(`bot ${this.identity.deviceId} battle aborted (${this.state}):`, (e as Error).message);
      })
      .finally(() => {
        this.battling = false;
        if (this.state !== 'offline') this.state = 'lobby_idle';
      });
  }

  private async runBattle(): Promise<void> {
    const wsUrl = this.gatewayUrl || this.battle.gatewayWsUrl;
    this.battleAbort = new AbortController();
    try {
      await playRankedMatch({
        gatewayWsUrl: wsUrl,
        jwt: this.token!,
        deck: BOT_DECK,
        difficulty: BOT_AI_DIFFICULTY,
        abortSignal: this.battleAbort.signal,
        onMatched: () => {
          if (this.state === 'matchmaking') this.state = 'in_battle';
        },
      });
    } finally {
      this.battleAbort = undefined;
    }
  }

  /** Idempotent: safe to call again on every login (commercial dedupes on orderId; a real card is never re-bought). */
  private async bootstrapPaymentTier(): Promise<void> {
    if (!this.accountId) return;
    const orderId = `bot-${this.identity.deviceId}-${this.identity.paymentTier}`;
    if (this.identity.paymentTier === 'monthly_card') {
      await this.commercial.buyMonthlyCard(this.accountId, orderId);
    } else if (this.identity.paymentTier === 'starter_growth') {
      await this.commercial.buyStarterGrowth(this.accountId, orderId);
    }
  }

  /** One tick of family upkeep (§3.3): join if familyless, leave+re-search if the current family looks dead. */
  async tickFamily(): Promise<void> {
    if (!this.token) return;
    const mine = await this.social.myFamily(this.token);
    if (!mine) {
      const candidates = await this.social.searchFamilies(this.token, '');
      const pick = candidates[0];
      if (pick) await this.social.joinFamily(this.token, pick.tag);
      return;
    }
    if (mine.prosperity < FAMILY_PROSPERITY_LEAVE_THRESHOLD) {
      await this.social.leaveFamily(this.token);
    }
  }

  /**
   * One tick of SLG upkeep (§3.2 slg_action): join the active season's world on first tick, then
   * either upgrade a building it can actually pay for or — every SIEGE_TICK_INTERVAL ticks — march a
   * minority of troops on a nearby occupied tile. No auction/social calls here (B8).
   *
   * Rate-limited per bot (DEFAULT_SLG_INTERVAL_MS) rather than acting on every upkeep pass handed to
   * it: the scheduler's pass cadence is tuned for its own CPU burst shape, and letting it double as
   * "how busy a bot is in the world" made every retune of one silently retune the other.
   */
  async tickSlg(): Promise<void> {
    if (!this.token) return;
    const now = Date.now();
    if (now < this.nextSlgAt) return;
    this.nextSlgAt = now + this.slg.intervalMs;
    if (!this.worldId) {
      const { season } = await this.world.getActiveSeason();
      const joined = await this.world.joinSeason(this.token, season);
      if (!joined.worldId) return;
      this.worldId = joined.worldId;
      this.noteSnapshot(joined, now);
    }
    this.slgTick++;
    if (this.slgTick % SIEGE_TICK_INTERVAL === 0 && (await this.trySiege())) return;
    await this.upgradeNextBuilding();
  }

  /**
   * Upgrade one building — but only one this bot can actually pay for.
   *
   * Until 2026-09-17 this fired the next key in a blind round-robin every single tick and let the
   * server reject it, which on live s2-0 meant **629,382 consecutive failures in 29 hours**
   * (`POST /world/build/upgrade` at 6/s, 64% of worldsvc's entire request volume, none of it ever
   * succeeding). A bot's base footprint covers exactly one resource tile, so it produces exactly one
   * of the five resources, while every entry in BUILD_COST_BASE costs paper and/or graphite plus, at
   * the higher keys, sticker/metal — so the overwhelming majority of bots can never afford anything,
   * forever. Nobody saw it because Scheduler.runUpkeep swallowed the rejection whole (fixed there too).
   *
   * This mirrors worldsvc's own validation (CityBuildingsService.upgradeBuilding) from the shared
   * constants rather than guessing, exactly as a real client greys out an unaffordable row instead of
   * posting it. The server stays authoritative: the mirror can only ever make the bot ask for LESS
   * than it is entitled to, because the snapshot's settled `resources` only grow with time.
   */
  private async upgradeNextBuilding(): Promise<void> {
    if (!this.token || !this.worldId) return;
    const me = await this.slgMe();
    const key = me && this.affordableBuilding(me);
    if (!key) return;
    const after = await this.world.upgradeBuilding(this.token, this.worldId, key);
    // The spend has happened either way, so a response we can't read must not leave the pre-spend
    // snapshot in place — that would have the bot ask for a second upgrade on money it no longer has.
    if (after) this.noteSnapshot(after, Date.now());
    else this.slgSnapshot = undefined;
  }

  /**
   * First key in the rotation this bot can pay for right now, or null. Scanning from the rotation
   * cursor (rather than always from `desk`) keeps the round-robin's spread-out feel for a bot rich
   * enough to have a choice, while a bot with exactly one affordable key still finds it every time.
   */
  private affordableBuilding(me: PlayerWorldView): BuildingKey | null {
    const queue = me.buildQueue ?? [];
    if (queue.length >= BUILD_QUEUE_SLOTS) return null; // 'Build queue is full'
    const buildings = me.buildings ?? { desk: 1 };
    const resources = me.resources ?? {};
    for (let i = 0; i < P1_BUILDING_KEYS.length; i++) {
      const key = P1_BUILDING_KEYS[(this.buildRotation + i) % P1_BUILDING_KEYS.length]!;
      const toLevel = (buildings[key] ?? 0) + queue.filter((e) => e.key === key).length + 1;
      if (buildGateReason(buildings, key, toLevel)) continue; // desk gate / max level
      const cost = buildCost(key, toLevel);
      if (RESOURCE_TYPES.some((rt) => (resources[rt] ?? 0) < (cost[rt] ?? 0))) continue;
      this.buildRotation = this.buildRotation + i + 1;
      return key;
    }
    return null;
  }

  /** The resource snapshot the upgrade decision reads, refreshed only when it has gone stale. */
  private async slgMe(): Promise<PlayerWorldView | undefined> {
    if (!this.token || !this.worldId) return undefined;
    const now = Date.now();
    if (this.slgSnapshot && now - this.slgSnapshotAt < SLG_SNAPSHOT_TTL_MS) return this.slgSnapshot;
    this.noteSnapshot(await this.world.getWorldMe(this.token, this.worldId), now);
    return this.slgSnapshot;
  }

  private noteSnapshot(me: PlayerWorldView, at: number): void {
    this.slgSnapshot = me;
    this.slgSnapshotAt = at;
  }

  /** Returns true if a march was actually started (so the caller skips the upgrade this tick). */
  private async trySiege(): Promise<boolean> {
    if (!this.token || !this.worldId) return false;
    const me = await this.world.getWorldMe(this.token, this.worldId);
    // Free refresh for the upgrade decision's snapshot — this is the same `/world/me` it would
    // otherwise have to fetch itself, and at the default cadence it is the ONLY one either needs.
    this.noteSnapshot(me, Date.now());
    const base = this.world.baseCoords(me);
    if (!base || !me.troops) return false;
    const { tiles } = await this.world.getWorldMapSparse(
      this.token,
      this.worldId,
      base.x,
      base.y,
      SIEGE_SCAN_RADIUS,
    );
    const target = this.world.pickAttackTarget(tiles);
    if (!target) return false;
    const troops = Math.max(1, Math.floor(me.troops * SIEGE_TROOP_FRACTION));
    await this.world.startMarchAttack(this.token, this.worldId, base, target, troops);
    return true;
  }
}
