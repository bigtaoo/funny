// Single bot session (BOTSVC_DESIGN §3.2): login, family join/leave-on-low-activity, payment-tier
// bootstrap, SLG city actions (§3.2 slg_action), and — this increment — ranked matchmaking + battle
// over a real gateway+gameserver WS connection driven by @nw/engine's AISystem (§1 B3, §8).
import { MetaClient } from './metaClient';
import { SocialClient } from './socialClient';
import { CommercialClient } from './commercialClient';
import { WorldClient, type BuildingKey } from './worldClient';
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
/** Sparse-map scan radius around the bot's own base when looking for a siege target. */
const SIEGE_SCAN_RADIUS = 5;

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
  private battling = false;

  constructor(
    readonly identity: BotIdentity,
    private readonly meta: MetaClient,
    private readonly social: SocialClient,
    private readonly commercial: CommercialClient,
    private readonly world: WorldClient,
    private readonly battle: BattleOptions,
  ) {}

  async login(): Promise<void> {
    this.state = 'logging_in';
    const login = await this.meta.deviceLogin(this.identity.deviceId);
    this.token = login.token;
    this.accountId = login.accountId;
    this.gatewayUrl = login.gatewayUrl;
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
      .catch(() => undefined)
      .finally(() => {
        this.battling = false;
        if (this.state !== 'offline') this.state = 'lobby_idle';
      });
  }

  private async runBattle(): Promise<void> {
    const wsUrl = this.gatewayUrl || this.battle.gatewayWsUrl;
    await playRankedMatch({
      gatewayWsUrl: wsUrl,
      jwt: this.token!,
      deck: BOT_DECK,
      difficulty: BOT_AI_DIFFICULTY,
      onMatched: () => {
        if (this.state === 'matchmaking') this.state = 'in_battle';
      },
    });
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
   * either upgrade the next building in rotation or — every SIEGE_TICK_INTERVAL ticks — march a
   * minority of troops on a nearby occupied tile. No auction/social calls here (B8).
   */
  async tickSlg(): Promise<void> {
    if (!this.token) return;
    if (!this.worldId) {
      const { season } = await this.world.getActiveSeason();
      const joined = await this.world.joinSeason(this.token, season);
      if (!joined.worldId) return;
      this.worldId = joined.worldId;
    }
    this.slgTick++;
    if (this.slgTick % SIEGE_TICK_INTERVAL === 0 && (await this.trySiege())) return;
    await this.upgradeNextBuilding();
  }

  private async upgradeNextBuilding(): Promise<void> {
    if (!this.token || !this.worldId) return;
    const key = P1_BUILDING_KEYS[this.buildRotation % P1_BUILDING_KEYS.length]!;
    this.buildRotation++;
    await this.world.upgradeBuilding(this.token, this.worldId, key);
  }

  /** Returns true if a march was actually started (so the caller skips the upgrade this tick). */
  private async trySiege(): Promise<boolean> {
    if (!this.token || !this.worldId) return false;
    const me = await this.world.getWorldMe(this.token, this.worldId);
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
