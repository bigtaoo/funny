// Single bot session (BOTSVC_DESIGN §3.2): login, family join/leave-on-low-activity, payment-tier
// bootstrap, SLG city actions, connected expansion and troop training (§3.2 slg_action, §3.4), and ranked
// matchmaking + battle over a real gateway+gameserver WS connection driven by @nw/engine's
// AISystem (§1 B3, §8).
import { SECT_CREATE_COST } from '@nw/shared';
import { MetaClient } from './metaClient';
import { SocialClient, type FamilyView } from './socialClient';
import { CommercialClient } from './commercialClient';
import { WorldClient, type PlayerWorldView } from './worldClient';
import { playRankedMatch } from './battleSession';
import type { BotIdentity } from './pool';
import { hasCode } from './apiError';
import { BOT_FAMILY_ROSTER, BOT_SECT_ROSTER, BotOrgRegistry, PENDING_SEAT_TTL_MS, botFamilySlot } from './orgs';
import { troopsFirst } from './training';
import { tryExpand, tryTrain, tryUpgrade } from './slgActions';
import { getLevel } from '@nw/engine';
import { hash32, pickLevel, playLevel, pveDifficulty, toEngineCards } from './pve';
import { planPveDay, utcDayStart } from './rotation';

/** Family upkeep pacing per role (BOTSVC_DESIGN §3.3): officers approve applications, members just idle. */
const FAMILY_SEEK_INTERVAL_MS = 60_000;
const FAMILY_OFFICER_INTERVAL_MS = 60_000;
const FAMILY_MEMBER_INTERVAL_MS = 10 * 60_000;
/**
 * After filing an application, don't try again for this long. The server allows one pending request
 * per account and never expires or lets you withdraw it, so re-applying sooner can only ever answer
 * ALREADY_REQUESTED; after this the bot looks again in case a full family rejected or dropped it.
 */
const PENDING_JOIN_RECHECK_MS = PENDING_SEAT_TTL_MS;
/** A leader keeps this many elders so applications still get approved while it is offline. */
const FAMILY_ELDER_TARGET = 2;

/**
 * Wall-clock floor between two SLG turns *for one bot*, independent of how the scheduler is tuned.
 * `tickSlg()` used to act on every upkeep pass it was handed, so its rate was a side effect of
 * `tickMs × upkeepRotations` (5s × 3 = one pass per bot per 15s) — two knobs that exist to shape the
 * scheduler's CPU burst, not to say how often a bot should touch the world. This decouples them: the
 * scheduler may visit a bot as often as it likes; the bot itself acts at most this often.
 *
 * 10 minutes since 2026-09-26 (was 45s, with a march considered every 5th pass): at 100/h per tile a
 * bot has nothing new to spend most of the time, and one of its marches takes minutes to arrive. One
 * turn now reads `/world/me` once and does everything worth doing — march, upgrade, train.
 */
export const DEFAULT_SLG_INTERVAL_MS = 10 * 60_000;

/** Per-bot SLG pacing (see DEFAULT_SLG_INTERVAL_MS); injected so tests can drive ticks without waiting. */
export interface SlgOptions {
  intervalMs: number;
}

/** Empty deck = server assigns defaultPvpDeck (RoomCreate.deck contract) — bots don't build loadouts. */
const BOT_DECK: string[] = [];
/** Mid-curve difficulty (AISystem.ts DIFFICULTY, L1-L10) — bots aren't meant to feel unbeatable or free wins. */
const BOT_AI_DIFFICULTY = 5;

export type BotState =
  | 'offline'
  | 'logging_in'
  | 'lobby_idle'
  | 'family_task'
  | 'slg_action'
  | 'matchmaking'
  | 'in_battle'
  | 'in_pve';

/** PvE pacing (BOTSVC_DESIGN §3.5); injected so tests control the dice and the in-level wait. */
export interface PveOptions {
  enabled: boolean;
  random: () => number;
  /** Waits `ms` (the level's own play time) or rejects when `signal` aborts (logout). */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The level itself (pve.ts playLevel). */
  play: typeof playLevel;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, Math.max(0, ms));
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

export const DEFAULT_PVE_OPTIONS: PveOptions = { enabled: true, random: Math.random, sleep: abortableSleep, play: playLevel };

/** Cumulative PvE outcomes for one bot, summed into /internal/bots/status by the scheduler. */
export interface PveCounters {
  /** Levels entered (stamina spent). */
  entered: number;
  cleared: number;
  lost: number;
  /** Clears the server picked for a spot check, and how many of those it accepted. */
  spotChecked: number;
  verified: number;
}

/** Re-exported for callers that used to find it here (moved to pve.ts alongside hash32, 2026-09-27). */
export { pveDifficulty };

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
  private buildRotation = 0;
  /** Earliest wall-clock time this bot may act in the world again (DEFAULT_SLG_INTERVAL_MS). */
  private nextSlgAt = 0;
  /** No new march before this (the previous one's arrival, BOTSVC_DESIGN §3.4 rule 6). */
  private marchBusyUntil = 0;
  private battling = false;
  /** Set while a battle is in flight (runBattle) — logout() aborts it instead of leaving the match
   *  running to completion against an account the fleet no longer tracks as online (2026-08-04 fix). */
  private battleAbort: AbortController | undefined;
  /** Earliest wall-clock time family upkeep runs again (interval depends on role, see tickFamily). */
  private nextFamilyAt = 0;
  /** Set after filing a join request: don't re-apply before this (PENDING_JOIN_RECHECK_MS). */
  private pendingJoinUntil = 0;
  /** UTC day `pveDue` was planned for; a new day replans and drops the old day's unplayed runs. */
  private pveDay = -1;
  /** Today's PvE start times still to play, ascending (rotation.ts planPveDay). */
  private pveDue: number[] = [];
  private pveAbort: AbortController | undefined;
  readonly pveCounters: PveCounters = { entered: 0, cleared: 0, lost: 0, spotChecked: 0, verified: 0 };

  constructor(
    readonly identity: BotIdentity,
    private readonly meta: MetaClient,
    private readonly social: SocialClient,
    private readonly commercial: CommercialClient,
    private readonly world: WorldClient,
    private readonly battle: BattleOptions,
    private readonly slg: SlgOptions = { intervalMs: DEFAULT_SLG_INTERVAL_MS },
    /** Process-wide: every session in the fleet must share one, or the seat/create bookkeeping is per-bot and useless. */
    private readonly orgs: BotOrgRegistry = new BotOrgRegistry(),
    private readonly pve: PveOptions = DEFAULT_PVE_OPTIONS,
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
    this.pveAbort?.abort();
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

  /**
   * Earliest PvE run this bot still owes today (Infinity when none), planning the day on first ask.
   * The scheduler reads it for OFFLINE bots too: one whose run is due logs in ahead of the others.
   */
  pveDueAt(now: number): number {
    if (!this.pve.enabled) return Infinity;
    const day = utcDayStart(now);
    if (day !== this.pveDay) {
      this.pveDay = day;
      this.pveDue = planPveDay(day, this.pve.random);
    }
    return this.pveDue[0] ?? Infinity;
  }

  /**
   * Starts today's next PvE run once it is due (BOTSVC_DESIGN §3.5), from lobby_idle only — a bot
   * mid-match finishes the match first. Like tickBattle(), the run is not awaited by the caller's
   * upkeep pass: it holds the bot in `in_pve` for the level's own play time. The returned promise
   * settles when the run does, so the scheduler can count failures.
   */
  tickPve(now = Date.now()): Promise<void> {
    if (this.state !== 'lobby_idle' || this.battling || !this.token) return Promise.resolve();
    if (this.pveDueAt(now) > now) return Promise.resolve();
    this.pveDue.shift();
    this.state = 'in_pve';
    const abort = (this.pveAbort = new AbortController());
    return this.runPve(this.token, abort.signal)
      .catch((e: unknown) => {
        // Logged out mid-level (session end, shedding): the player walked away, not a failure.
        if (!abort.signal.aborted) throw e;
      })
      .finally(() => {
        this.pveAbort = undefined;
        if (this.state === 'in_pve') this.state = 'lobby_idle';
      });
  }

  /**
   * One level, the way the client plays it: read the save, pick a level, spend stamina at
   * /pve/enter, play it, and — having taken as long as the level really lasts — report a clear to
   * /pve/clear, sending the frames to /pve/verify when the server picks it for a spot check. A loss is
   * reported nowhere, same as the client (stamina stays spent).
   */
  private async runPve(token: string, signal: AbortSignal): Promise<void> {
    const save = await this.meta.getSave(token);
    if (signal.aborted) return;
    const levelId = pickLevel(save.progress, this.pve.random);
    const level = levelId ? getLevel(levelId) : null;
    if (!levelId || !level) return;
    try {
      await this.meta.pveEnter(token, levelId);
    } catch (e) {
      // 10 stamina a run against 120 held and 1 per 6 min regained: only a bot that bought nothing
      // and played far past its plan runs dry, and a player who is out of stamina just doesn't play.
      if (hasCode(e, 'INSUFFICIENT_STAMINA')) return;
      throw e;
    }
    this.pveCounters.entered++;
    const startedAt = Date.now();
    const run = await this.pve.play(
      level,
      { cardInstances: toEngineCards(save.cardInv), equipmentInv: save.equipmentInv ?? {} },
      { aiSeed: hash32(this.identity.deviceId) ^ startedAt, difficulty: pveDifficulty(this.identity.deviceId) },
    );
    // The simulation takes milliseconds; the level takes endFrame/30 seconds. Report when a player would.
    await this.pve.sleep(startedAt + (run.endFrame * 1000) / 30 - Date.now(), signal);
    if (!run.won) {
      this.pveCounters.lost++;
      return;
    }
    const clear = await this.meta.pveClear(token, levelId, run.stars, run.stats);
    this.pveCounters.cleared++;
    if (clear.needsReplay && clear.verifyId) {
      this.pveCounters.spotChecked++;
      const v = await this.meta.pveVerify(token, clear.verifyId, run.endFrame, run.frames);
      if (v.verified) this.pveCounters.verified++;
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

  /**
   * One tick of family + sect upkeep (§3.3). A familyless bot applies to the first bot family with a
   * free seat, or founds the next roster slot once all earlier ones are full; officers approve every
   * pending application; leaders also appoint elders and get their family into a bot sect.
   *
   * Until 2026-09-26 this failed on every single call (1.2M times on live): it searched with an empty
   * `tag` the route rejects, joined by TAG instead of family id, and never knew joining had become an
   * application someone has to approve. No bot was ever in a family.
   */
  async tickFamily(): Promise<void> {
    if (!this.token) return;
    const now = Date.now();
    if (now < this.nextFamilyAt) return;
    const mine = await this.social.myFamily(this.token);
    if (!mine) {
      this.nextFamilyAt = now + FAMILY_SEEK_INTERVAL_MS;
      await this.seekFamily(now);
      return;
    }
    this.orgs.clearPending(this.identity.deviceId);
    const role = mine.members?.find((m) => m.accountId === this.accountId)?.role ?? 'member';
    if (role === 'member') {
      this.nextFamilyAt = now + FAMILY_MEMBER_INTERVAL_MS;
      return;
    }
    this.nextFamilyAt = now + FAMILY_OFFICER_INTERVAL_MS;
    await this.approveJoinRequests();
    if (role !== 'leader') return;
    await this.appointElder(mine);
    await this.tickSect(mine);
  }

  private async seekFamily(now: number): Promise<void> {
    if (!this.token || now < this.pendingJoinUntil) return;
    const pick = await this.orgs.pickFamily(this.social, this.token);
    if (!pick) return;
    if (pick.kind === 'create') {
      const { name, tag } = BOT_FAMILY_ROSTER[pick.slot]!;
      try {
        this.orgs.noteFamily(pick.slot, await this.social.createFamily(this.token, name, tag));
      } catch (e) {
        // Lost the race to another founder, or a human took the TAG: re-read the slot next time.
        this.orgs.forgetFamily(pick.slot);
        throw e;
      }
      return;
    }
    try {
      await this.social.requestJoin(this.token, pick.familyId);
    } catch (e) {
      if (hasCode(e, 'FAMILY_FULL', 'NOT_FOUND')) {
        this.orgs.forgetFamily(pick.slot);
        return;
      }
      // Our one allowed pending request already exists (possibly filed before a restart) — wait on it.
      if (!hasCode(e, 'ALREADY_REQUESTED')) throw e;
    }
    this.orgs.notePending(pick.slot, this.identity.deviceId);
    this.pendingJoinUntil = now + PENDING_JOIN_RECHECK_MS;
  }

  /**
   * Accept every pending application. Once the family is full the rest are rejected rather than left
   * sitting: an applicant can hold only one request and cannot withdraw it, so a request nobody will
   * ever accept pins that bot familyless until someone says no.
   */
  private async approveJoinRequests(): Promise<void> {
    if (!this.token) return;
    const requests = await this.social.listJoinRequests(this.token);
    let full = false;
    for (const r of requests) {
      if (!full) {
        try {
          await this.social.respondJoinRequest(this.token, r.requestId, true);
          continue;
        } catch (e) {
          // FAMILY_FULL: the accept already consumed this request server-side; the applicant is free.
          // ALREADY_IN_FAMILY: they got into another family first. Neither is ours to retry.
          if (hasCode(e, 'FAMILY_FULL')) full = true;
          else if (!hasCode(e, 'ALREADY_IN_FAMILY', 'NOT_FOUND')) throw e;
          continue;
        }
      }
      await this.social.respondJoinRequest(this.token, r.requestId, false).catch((e: unknown) => {
        if (!hasCode(e, 'NOT_FOUND')) throw e;
      });
    }
  }

  /** Promote the longest-serving plain member, one per tick, until FAMILY_ELDER_TARGET elders exist. */
  private async appointElder(mine: FamilyView): Promise<void> {
    if (!this.token || !mine.members) return;
    if (mine.members.filter((m) => m.role === 'elder').length >= FAMILY_ELDER_TARGET) return;
    const candidate = mine.members
      .filter((m) => m.role === 'member' && m.accountId)
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (candidate) await this.social.setRole(this.token, candidate.accountId!, 'elder');
  }

  /**
   * Leader-only sect step, in the world this bot joined via tickSlg. Leaders of family slots 0..2
   * found the three roster sects; every other bot family joins the emptiest one with room.
   */
  private async tickSect(mine: FamilyView): Promise<void> {
    if (!this.token || !this.accountId || !this.worldId || mine.sectId) return;
    const familySlot = botFamilySlot(mine);
    if (familySlot < 0) return;
    const worldId = this.worldId;
    const sects = await this.orgs.sectsIn(this.world, this.token, worldId);
    const own = BOT_SECT_ROSTER[familySlot];
    if (own && !sects.some((s) => s.tag === own.tag)) {
      // No bot has SECT_CREATE_COST on its own (live max: 1450 coins), so the founder is granted it once;
      // the orderId makes a retry after a failed create a no-op instead of a second grant.
      await this.commercial.grantCoins(
        this.accountId,
        SECT_CREATE_COST,
        `bot-sect-${this.identity.deviceId}-${worldId}`,
        'bot_sect_found',
      );
      this.orgs.forgetSects(worldId);
      await this.world.createSect(this.token, worldId, own.name, own.tag);
      return;
    }
    const target = BotOrgRegistry.pickSect(sects);
    if (!target) return;
    try {
      await this.world.joinSect(this.token, worldId, target.sectId);
    } finally {
      this.orgs.forgetSects(worldId);
    }
  }

  /**
   * One SLG turn (§3.2 slg_action, BOTSVC_DESIGN §3.4): join the active season's world on the first
   * one, then from a single fresh `/world/me` — march on the next tile bordering the sect's land
   * (expansion.ts), then upgrade a building and train troops it can actually pay for (training.ts).
   * No auction/social calls here (B8).
   *
   * Upgrade and training draw on the same resources, so their order is the priority: a bot whose pool
   * is too small to march trains first, otherwise buildings go first and training takes what is left.
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
    let me: PlayerWorldView;
    if (!this.worldId) {
      const { season } = await this.world.getActiveSeason();
      const joined = await this.world.joinSeason(this.token, season);
      if (!joined.worldId) return;
      this.worldId = joined.worldId;
      me = joined;
    } else {
      me = await this.world.getWorldMe(this.token, this.worldId);
    }
    const expanded = await tryExpand(this.world, this.token, this.worldId, me, now, this.marchBusyUntil);
    this.marchBusyUntil = expanded.marchBusyUntil;
    // The march took its troops out of the pool; resources are untouched, so no second read is needed.
    if (expanded.sent) me = { ...me, troops: (me.troops ?? 0) - expanded.sent };
    const steps = troopsFirst(me)
      ? [(v: PlayerWorldView) => tryTrain(this.world, this.token, this.worldId, v), (v: PlayerWorldView) => this.stepUpgrade(v)]
      : [(v: PlayerWorldView) => this.stepUpgrade(v), (v: PlayerWorldView) => tryTrain(this.world, this.token, this.worldId, v)];
    for (const step of steps) {
      const next = await step(me);
      if (!next) return;
      me = next;
    }
  }

  /** Thin wrapper so tickSlg's step list can read/write buildRotation without slgActions.ts knowing the session. */
  private async stepUpgrade(me: PlayerWorldView): Promise<PlayerWorldView | undefined> {
    const { view, buildRotation } = await tryUpgrade(this.world, this.token, this.worldId, me, this.buildRotation);
    this.buildRotation = buildRotation;
    return view;
  }
}
