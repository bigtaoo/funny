// Single bot session (BOTSVC_DESIGN §3.2). This increment wires the parts that are pure REST and safe to
// drive headless today: login, family join/leave-on-low-activity, payment-tier bootstrap, and SLG city
// actions (§3.2 slg_action: building upgrades + occasional siege marches). Matchmaking / battle (AISystem
// over a real gateway+gameserver WS connection, §1 B3) is the remaining increment — left as an explicit
// extension point rather than faked, see BOTSVC_DESIGN §8.
import { MetaClient } from './metaClient';
import { SocialClient } from './socialClient';
import { CommercialClient } from './commercialClient';
import { WorldClient, type BuildingKey } from './worldClient';
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

export type BotState = 'offline' | 'logging_in' | 'lobby_idle' | 'family_task' | 'slg_action';

export class BotSession {
  state: BotState = 'offline';
  private token: string | undefined;
  private accountId: string | undefined;
  private paymentBootstrapped = false;
  private worldId: string | undefined;
  private slgTick = 0;
  private buildRotation = 0;

  constructor(
    readonly identity: BotIdentity,
    private readonly meta: MetaClient,
    private readonly social: SocialClient,
    private readonly commercial: CommercialClient,
    private readonly world: WorldClient,
  ) {}

  async login(): Promise<void> {
    this.state = 'logging_in';
    const login = await this.meta.deviceLogin(this.identity.deviceId);
    this.token = login.token;
    this.accountId = login.accountId;
    if (!this.paymentBootstrapped) {
      await this.bootstrapPaymentTier();
      this.paymentBootstrapped = true;
    }
    this.state = 'lobby_idle';
  }

  logout(): void {
    this.token = undefined;
    this.accountId = undefined;
    this.state = 'offline';
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
