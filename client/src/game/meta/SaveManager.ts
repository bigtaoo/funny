// Cloud sync orchestration (S0-5). Offline-first + server-authoritative:
//   · On startup call loadLocal (immediately playable, works without network).
//   · bootstrap(): auth → pull → reconcile (server value always wins — see reconcile()'s doc comment).
//   · Every writable field (equipped.*/flags.*/equipmentInv/cardInv/wallet/progress/...) goes through its
//     own dedicated server round trip; there is no generic client-sync push any more (PUT /save removed,
//     DECISIONS.md "equipped/flags server-authoritative") — a refresh always reflects true server state,
//     it can no longer perpetuate a locally-corrupted equipped/flags value forever.
// Network unavailable / ApiClient not configured → silently degrade to local-only (no error thrown to caller).

import type { AuthCredential } from '../../platform/IPlatform';
import { ApiError, type ApiClient, type ActiveMatchInfo } from '../../net/ApiClient';
import { replayToUploadFrames } from '../../net/replayUpload';
import type { Replay } from '../types';
import type { UnitType } from '../types';
import {
  type CardInstance,
  type EquipmentInstance,
  type LeanSaveResponse,
  type LevelRecord,
  type SaveData,
} from './SaveData';
import { migrate } from './migrate';
import { skinEquipKey } from './skinDefs';
import { replayIdFor } from './ReplayStore';
import type { PendingClear, PendingStaminaSpend, SaveStore } from './SaveStore';
import { serverNow } from '../../net/serverClock';

// Stamina constants (A4) — mirrors server/metaserver/src/service/base.ts STAMINA_CAP/STAMINA_REGEN_MS,
// needed here so entering a level can deduct correctly even fully offline (no server round-trip available).
const STAMINA_CAP = 120;
const STAMINA_REGEN_MS = 6 * 60 * 1000; // 6 min per point

export interface SaveManagerOpts {
  store: SaveStore;
  /** Cloud client; omitted → local-only (offline-first). */
  api?: ApiClient;
  /** Retrieve the platform anonymous credential (S0-4); only needed when api is configured. */
  getCredential?: () => Promise<AuthCredential>;
  /**
   * Account profile returned from the cloud; called back after bootstrap/refresh pulls it. Used for client persistence / UI refresh / online connectivity.
   * `gatewayUrl`: the control-plane WS address delivered by the server (not hardcoded on the client; see ApiClient.AuthResult).
   */
  onProfile?: (profile: { displayName?: string; publicId?: string; gatewayUrl?: string; freeRename?: boolean }) => void;
  /** Retrieve a local replay (ReplayStore); during L1 spot-check, offline flush uses replayId to fetch and upload for server re-validation (§8.6). */
  loadReplay?: (id: string) => Replay | null;
}

export class SaveManager {
  private save: SaveData;
  private readonly store: SaveStore;
  private readonly api?: ApiClient;
  private readonly getCredential?: () => Promise<AuthCredential>;
  private readonly onProfile?: (profile: { displayName?: string; publicId?: string; gatewayUrl?: string; freeRename?: boolean }) => void;
  private readonly loadReplay?: (id: string) => Replay | null;
  /**
   * Login-reconnect-prompt: the most recent activeMatch seen from a getSave() response, or null if the
   * last check found none. Read-and-clear via consumeActiveMatch() so only the login entry points (which
   * call it once, right after bootstrap()/adoptSession()) act on it — other refresh() callers (e.g. the
   * post-match ELO refresh) don't accidentally retrigger the resume prompt.
   */
  private pendingActiveMatch: ActiveMatchInfo | null = null;
  private pending: PendingClear[]; // offline queue of clears awaiting settlement (PVE_INTEGRITY_PLAN §8.4)
  private pendingStamina: PendingStaminaSpend[]; // offline queue of stamina spends awaiting server settlement (A4)

  constructor(opts: SaveManagerOpts) {
    this.store = opts.store;
    this.api = opts.api;
    this.getCredential = opts.getCredential;
    this.onProfile = opts.onProfile;
    this.loadReplay = opts.loadReplay;
    this.save = this.store.loadLocal();
    this.pending = this.store.loadPending();
    this.pendingStamina = this.store.loadPendingStamina();
  }

  /** Current in-memory save (synchronously readable; UI balances etc. read from here and are refreshed by server push-back). */
  get(): SaveData {
    return this.save;
  }

  /**
   * Mutate a local mirror field and save locally. For fields the server also computes independently
   * (pvp.elo/rank after a ranked match, stamina after a WS push), this just keeps the in-memory copy in
   * sync with what the server already told the client via another channel — nothing is uploaded from
   * here. Do NOT use this for equipped/flags (use equipTitle/equipAvatar/equipSkin/setFlag — each goes
   * through its own validated server round trip) or any other server-authoritative section.
   */
  update(mutator: (draft: SaveData) => void): void {
    mutator(this.save);
    this.store.saveLocal(this.save);
  }

  /** Mutate local-only fields (never synced to the server at all) and save locally. */
  patchLocal(patch: Pick<Partial<import('./SaveData').SaveData>, 'pvpDeck'>): void {
    Object.assign(this.save, patch);
    this.store.saveLocal(this.save);
  }

  /**
   * Set one client-preference flag (server-authoritative, PUT /flags — onboarding/consent/tutorial-seen
   * style booleans, no ownership semantics). Writes the local mirror immediately for instant UI feedback,
   * then fires the server round trip in the background; the response's reconcile() confirms it, and on
   * failure a follow-up refresh() re-pulls true server state — so a rejected/lost write self-corrects on
   * the very next sync instead of silently diverging forever (see reconcile()'s doc comment).
   */
  setFlag(key: string, value: boolean): void {
    this.save.flags[key] = value;
    this.store.saveLocal(this.save);
    if (!this.online()) return;
    this.api!.setFlag(key, value).then(
      (res) => this.reconcile(res.save),
      () => { void this.refresh(); },
    );
  }

  getFlag(key: string): boolean {
    return this.save.flags[key] === true;
  }

  /**
   * First-time feature onboarding (ONBOARDING_DESIGN §4.1): whether the player has already seen the onboarding tour for a given feature page.
   * The flat key `featSeen.<id>` is stored in the flags map (Record<string,boolean>); no SaveData schema change required.
   */
  featSeen(featureId: string): boolean {
    return this.save.flags[`featSeen.${featureId}`] === true;
  }

  /** Mark a feature's onboarding tour as seen (will no longer auto-popup after being seen/dismissed; the page "?" button can force a replay without clearing this flag). */
  markFeatSeen(featureId: string): void {
    this.setFlag(`featSeen.${featureId}`, true);
  }

  /** Select the displayed title (TITLE_DESIGN §7); empty/null unequips. Same optimistic-write + self-correcting pattern as setFlag — see its doc comment. */
  equipTitle(titleId: string | null): void {
    this.optimisticEquip('title', titleId, () => this.api!.equipTitle(titleId ?? ''));
  }

  /** Select the displayed avatar (composite "<category>:<key>"); empty/null unequips. Same optimistic-write + self-correcting pattern as setFlag. */
  equipAvatar(avatarId: string | null): void {
    this.optimisticEquip('avatar', avatarId, () => this.api!.equipAvatar(avatarId ?? ''));
  }

  /** Equip/unequip a character skin (one slot per UnitType, LOBBY_IA_REDESIGN §15); skinId null unequips. Same optimistic-write + self-correcting pattern as setFlag. */
  equipSkin(unitType: UnitType, skinId: string | null): void {
    this.optimisticEquip(skinEquipKey(unitType), skinId, () => this.api!.equipSkin(unitType, skinId));
  }

  /**
   * Shared optimistic-write helper for equipTitle/equipAvatar/equipSkin: writes `equipped[key]` locally
   * for instant UI feedback, then fires the server round trip in the background. A rejected request
   * (unowned item, 403) or a network failure is corrected by the follow-up refresh() — never left stuck,
   * unlike the old "local always wins" client-sync merge this replaces.
   */
  private optimisticEquip(key: string, value: string | null, call: () => Promise<{ save: SaveData }>): void {
    if (value) this.save.equipped[key] = value; else delete this.save.equipped[key];
    this.store.saveLocal(this.save);
    if (!this.online()) return;
    call().then(
      (res) => this.reconcile(res.save),
      () => { void this.refresh(); },
    );
  }

  /**
   * Bootstrap cloud sync: exchange token → pull → reconcile → push if needed.
   * Any network/auth failure is swallowed (local playability is preserved); returns whether the cloud connection succeeded.
   */
  async bootstrap(): Promise<boolean> {
    if (!this.api || !this.getCredential) return false;
    try {
      const cred = await this.getCredential();
      const auth = await this.api.auth(cred);
      this.save.accountId = auth.accountId;
      this.store.saveLocal(this.save);

      const cloud = await this.api.getSave();
      this.reconcile(cloud.save);
      this.pendingActiveMatch = cloud.activeMatch ?? null;
      this.onProfile?.({
        displayName: cloud.displayName,
        publicId: auth.publicId ?? cloud.publicId,
        gatewayUrl: auth.gatewayUrl ?? cloud.gatewayUrl,
        freeRename: cloud.freeRename,
      });
      await this.flushPending(); // settle clears that were queued offline
      await this.flushPendingStamina(); // settle stamina spends that were queued offline
      return true;
    } catch {
      // Offline / server unreachable: stay on local data, no error thrown.
      return false;
    }
  }

  /**
   * Actively pull the cloud save and reconcile (no re-auth; reuses the existing token).
   * Used to refresh local state after a server-authoritative section has been modified outside the client —
   * e.g. after a ranked match the gameserver writes `pvp` (elo/rank/streak) and the client refreshes the
   * lobby rank immediately, without waiting for the next bootstrap.
   * No-op if not connected; no error thrown.
   */
  async refresh(): Promise<boolean> {
    if (!this.api?.hasToken()) return false;
    try {
      const cloud = await this.api.getSave();
      this.reconcile(cloud.save);
      this.pendingActiveMatch = cloud.activeMatch ?? null;
      this.onProfile?.({
        displayName: cloud.displayName,
        publicId: cloud.publicId,
        gatewayUrl: cloud.gatewayUrl,
        freeRename: cloud.freeRename,
      });
      await this.flushPending(); // settle clears queued offline after reconnection
      await this.flushPendingStamina(); // settle stamina spends queued offline after reconnection
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Login-reconnect-prompt: read-and-clear the most recent activeMatch signal (or null if none).
   * Call this once right after bootstrap()/adoptSession() resolves — not after every refresh() — so the
   * "resume your match?" prompt only surfaces at login, not on unrelated mid-session save refreshes.
   */
  consumeActiveMatch(): ActiveMatchInfo | null {
    const m = this.pendingActiveMatch;
    this.pendingActiveMatch = null;
    return m;
  }

  /**
   * Adopt session after a formal login/registration (SA-3/SA-4): the token is already held by ApiClient;
   * here we persist accountId locally and pull + reconcile (offline PvE progress is merged into the cloud save,
   * authoritative sections use the cloud value, §4.4).
   * Unlike bootstrap, this does not re-auth (no anonymous device credential exchange). No-op if not connected.
   */
  async adoptSession(accountId: string): Promise<boolean> {
    this.save.accountId = accountId;
    this.store.saveLocal(this.save);
    return this.refresh();
  }

  /**
   * Blank the in-memory equipped/flags/pvpDeck immediately on logout, purely to avoid a visual flash of
   * the previous account's avatar/title/flags in the gap before the next login's reconcile() resolves —
   * reconcile() itself always takes the cloud value for equipped/flags now (see its doc comment), so this
   * is a UI nicety, not a correctness requirement. Call from doLogout() before the next login.
   */
  clearSyncedLocalSections(): void {
    this.save.equipped = {};
    this.save.flags = {};
    delete this.save.pvpDeck;
    this.store.saveLocal(this.save);
  }

  /**
   * Adopt an authoritative save pushed back by a server-side economy operation (shop/gacha/recharge/ad) (S2).
   * Unlike refresh, this directly consumes the receipt without issuing an additional request.
   */
  adoptServer(save: SaveData): void {
    this.reconcile(save);
  }

  /**
   * Adopt an authoritative save pushed back by an /equipment/* mutation (craft/enhance/salvage/reforge/equip)
   * (EQUIPMENT_DESIGN §3.3 phase 2, 2026-07-26) or by /gacha/draw (2026-07-28). These responses send
   * `equipmentInv`/`cardInv` as `null` (see `LeanSaveResponse`) instead of the full map, since the caller
   * already has what changed: the `instance` handed back by craft/enhance/reforge, the `instanceIds`/
   * `materialId` it sent as request params for salvage/reforge, or gacha draw's own `cardGrants`/
   * `equipmentGrants`. Must NOT go through the plain `adoptServer`/`reconcile` path — that does a
   * wholesale `{...cloud, ...}` replace, and a `null`/missing `equipmentInv`/`cardInv` on `cloud` would
   * wipe the local inventory rather than leave it alone. Instead this reconstructs full maps locally
   * (existing inventory + the patch) and only then hands them to the same tested `reconcile` pipeline —
   * the delta bookkeeping is confined to this one seam, everything downstream is unchanged. `cardUpsert`/
   * `cardRemove` default to a no-op patch so existing equipment-only call sites are unaffected.
   */
  adoptServerPartial(
    save: LeanSaveResponse,
    patch: { upsert?: EquipmentInstance[]; remove?: string[]; cardUpsert?: CardInstance[]; cardRemove?: string[] },
  ): void {
    const equipmentInv = { ...this.save.equipmentInv };
    for (const id of patch.remove ?? []) delete equipmentInv[id];
    for (const inst of patch.upsert ?? []) equipmentInv[inst.id] = inst;
    const cardInv = { ...this.save.cardInv };
    for (const id of patch.cardRemove ?? []) delete cardInv[id];
    for (const inst of patch.cardUpsert ?? []) cardInv[inst.id] = inst;
    this.reconcile({ ...save, equipmentInv, cardInv });
  }

  // ── PvE server authority (PVE_INTEGRITY_PLAN §8) ────────────────────────────
  // progress/materials/pveUpgrades are server-authoritative; clears/upgrades go through /pve/* endpoints, adopted after push-back.
  // Offline (no token): clears are queued for later settlement (local authoritative values unchanged); upgrades disabled.

  /** Whether the server-authoritative section is reachable and writable (api + token present). Scenes use this for online gating. */
  online(): boolean {
    return !!this.api?.hasToken();
  }

  /** Offline queue of clears pending settlement (read-only copy for UI to display "pending" state). */
  getPendingClears(): PendingClear[] {
    return this.pending.slice();
  }

  /** Offline queue of stamina spends pending server settlement (read-only copy; mainly for tests/diagnostics). */
  getPendingStaminaSpends(): PendingStaminaSpend[] {
    return this.pendingStamina.slice();
  }

  /**
   * Spend stamina to enter a level (A4, 2026-07-06): deducted the moment the player commits, not at clear,
   * so retreating or losing mid-level does not refund it. Deducts the local mirror immediately and
   * unconditionally — including fully offline, so the player sees the cost right away — then settles with
   * the server in the background (online) or queues for settlement on reconnect (offline / request failed).
   * Returns false without deducting anything when the (regen-adjusted) balance is below cost.
   */
  spendStaminaForLevel(levelId: string, cost: number): boolean {
    const regen = this.regenStamina();
    if (regen.current < cost) {
      this.save.stamina = regen; // still persist the regen catch-up even when entry is blocked
      this.store.saveLocal(this.save);
      return false;
    }
    const current = regen.current - cost;
    const regenAt = regen.regenAt !== 0 ? regen.regenAt : current < STAMINA_CAP ? serverNow() + STAMINA_REGEN_MS : 0;
    this.save.stamina = { current, regenAt };
    this.store.saveLocal(this.save);
    if (this.online()) {
      this.api!.pveEnter(levelId).then((res) => {
        this.save.stamina = res.stamina;
        this.store.saveLocal(this.save);
      }).catch(() => this.enqueueStaminaSpend({ levelId, cost, ts: Date.now() }));
    } else {
      this.enqueueStaminaSpend({ levelId, cost, ts: Date.now() });
    }
    return true;
  }

  /** Apply natural regen to the local stamina mirror (same algorithm as server deductStamina/readStaminaSnapshot) without persisting; caller decides whether/how to save the result. */
  private regenStamina(): { current: number; regenAt: number } {
    // serverNow() (P1-1): regenAt may hold a server-issued value (from a prior pveEnter response) —
    // comparing it against the client's raw local clock would under/over-count regen ticks by the
    // clock's drift each time this runs.
    const now = serverNow();
    let { current, regenAt } = this.save.stamina ?? { current: STAMINA_CAP, regenAt: 0 };
    if (current < STAMINA_CAP && regenAt > 0 && now >= regenAt) {
      const ticks = Math.floor((now - regenAt) / STAMINA_REGEN_MS) + 1;
      current = Math.min(STAMINA_CAP, current + ticks);
      regenAt = current >= STAMINA_CAP ? 0 : regenAt + ticks * STAMINA_REGEN_MS;
    }
    return { current, regenAt };
  }

  private enqueueStaminaSpend(entry: PendingStaminaSpend): void {
    this.pendingStamina.push(entry);
    this.store.savePendingStamina(this.pendingStamina);
  }

  /** Flush the pending stamina-spend queue in order once back online: the local mirror is already deducted, so this only settles the server's authoritative copy (best-effort). */
  private async flushPendingStamina(): Promise<void> {
    if (!this.online()) return;
    while (this.pendingStamina.length > 0) {
      const head = this.pendingStamina[0]!;
      try {
        const res = await this.api!.pveEnter(head.levelId);
        this.save.stamina = res.stamina;
        this.store.saveLocal(this.save);
        this.pendingStamina.shift();
        this.store.savePendingStamina(this.pendingStamina);
      } catch (e) {
        if (e instanceof ApiError) {
          // Business error (unknown level etc.): cannot be settled server-side; drop it rather than block the queue (local deduction already stands).
          this.pendingStamina.shift();
          this.store.savePendingStamina(this.pendingStamina);
          continue;
        }
        break; // network error: keep queue, retry next time
      }
    }
  }

  /**
   * Record a level clear (stars >= 1). Online → POST /pve/clear to settle immediately and adopt the push-back;
   * offline / request failed → enqueue (local authoritative values unchanged), flush when back online.
   * L1 spot-check (§8.6 step 3): when the server returns `needsReplay`, materials are held back and the
   * replay for this run is uploaded to /pve/verify for re-calculation and crediting.
   */
  /**
   * @param stats Per-run achievement stat deltas (achievementStatDelta output); S9-3b, regular clears feed these counts into the server.
   */
  async recordClear(levelId: string, stars: number, replay?: Replay, stats?: Record<string, number>): Promise<void> {
    if (stars <= 0) return;
    // Optimistic local unlock (offline-first): write the clear into local progress immediately so the next
    // level is unlocked when returning to CampaignMap — no waiting for the server receipt (online recordClear
    // is fire-and-forget; the scene would already have been rebuilt before the receipt arrives and would read the stale value).
    // The server still settles authoritatively: online adoptServer / offline flush followed by reconcile overwrites
    // with the cloud cleared/stars in full; even a server-side rejection gets corrected (self-healing), so the optimistic value never drifts.
    this.applyLocalClear(levelId, stars);
    if (this.online()) {
      try {
        const res = await this.api!.pveClear(levelId, stars, {}, stats);
        this.adoptServer(res.save);
        if (res.needsReplay && res.verifyId && replay) {
          await this.verifyReplay(res.verifyId, replay);
        }
        return;
      } catch {
        // Online but request failed (network blip) → enqueue as fallback, flush next time
      }
    }
    this.enqueueClear({
      levelId,
      stars,
      ts: Date.now(),
      ...(replay?.meta?.recordedAt !== undefined
        ? { replayId: replayIdFor(replay.meta.recordedAt) }
        : {}),
    });
  }

  /** Upload the replay to /pve/verify for re-calculation → adopt push-back (materials credited). Failure is silent (the server-side record stays pending). */
  private async verifyReplay(verifyId: string, replay: Replay): Promise<void> {
    try {
      const res = await this.api!.pveVerify(verifyId, replay.endFrame, replayToUploadFrames(replay));
      this.adoptServer(res.save);
    } catch {
      /* Network/re-calculation error → materials not credited this round; server-side record stays pending (does not block local flow) */
    }
  }

  /**
   * @deprecated S3-2 per-stat upgrade. Since CC-1 unit progression is per-card via the Hero Roster (cardInv), not this path.
   */
  async upgrade(upgradeId: string): Promise<boolean> {
    if (!this.online()) return false;
    try {
      const res = await this.api!.pveUpgrade(upgradeId);
      this.adoptServer(res.save);
      return true;
    } catch {
      return false;
    }
  }

  /** Optimistically write a local clear: append to cleared (deduped) + take the higher stars value (clamped to 1|2|3). Local-only (progress is not uploaded). */
  private applyLocalClear(levelId: string, stars: number): void {
    const p = this.save.progress;
    if (!p.cleared.includes(levelId)) p.cleared.push(levelId);
    const s = Math.max(1, Math.min(3, Math.round(stars))) as 1 | 2 | 3;
    if ((p.stars[levelId] ?? 0) < s) p.stars[levelId] = s;
    this.store.saveLocal(this.save);
  }

  private enqueueClear(entry: PendingClear): void {
    this.pending.push(entry);
    this.store.savePending(this.pending);
  }

  /** Flush the pending-settlement queue in order once back online: adopt after each success; keep on network failure for next attempt, discard on business error. */
  private async flushPending(): Promise<void> {
    if (!this.online()) return;
    while (this.pending.length > 0) {
      const head = this.pending[0];
      try {
        const res = await this.api!.pveClear(head.levelId, head.stars, {});
        this.adoptServer(res.save);
        // L1 spot-check triggered: retrieve the local replay and upload for re-calculation (if evicted from ReplayStore, skip — materials not credited this round).
        if (res.needsReplay && res.verifyId && head.replayId && this.loadReplay) {
          const replay = this.loadReplay(head.replayId);
          if (replay) await this.verifyReplay(res.verifyId, replay);
        }
        this.pending.shift();
        this.store.savePending(this.pending);
      } catch (e) {
        if (e instanceof ApiError) {
          // Business error (level not unlocked / invalid parameters): this entry cannot be settled; discard it to avoid permanently blocking the queue.
          this.pending.shift();
          this.store.savePending(this.pending);
          continue;
        }
        break; // network error: keep queue, retry next time
      }
    }
  }

  /**
   * reconcile: every server-authoritative section (which, as of this refactor, is everything except
   * pvpDeck) always takes the cloud value — no client-side field is ever allowed to permanently override
   * a fresh server pull any more. progress.best is a local display stat (never uploaded, carries no
   * reward semantics) → union of better values preserves local data. rev/accountId taken from cloud.
   * This is what makes a plain refresh (bootstrap/refresh/adoptSession all funnel through here) a genuine
   * cure-all: whatever got a client-local field into a wrong state — a race, a rejected optimistic write
   * in equipTitle/equipAvatar/equipSkin/setFlag, a bug — the very next successful sync always overwrites
   * it with server truth. There is deliberately no "local wins" branch left (that used to apply to
   * equipped/flags forever, with no way for any future sync to correct a bad local value — see git
   * history / DECISIONS.md "equipped/flags server-authoritative" for the incident that prompted this).
   */
  private reconcile(cloudRaw: SaveData): void {
    // Normalize the raw cloud document to the current shape before adopting: an older account's save may
    // lack client-only fields (cardInv/equipmentInv), which would otherwise crash the campaign start path.
    // migrate is idempotent for a complete save.
    const cloud = migrate(cloudRaw);
    // Drop a stale/out-of-order response: several call sites (bootstrap/refresh/adoptServer) fire from
    // rapid-fire user actions (e.g. mashing gacha draw) without a busy-guard, so responses can land out
    // of order — a slow earlier request's response arriving after a faster later one's. Since every
    // server mutation bumps `rev`, a lower rev than what's already loaded is unambiguously older data;
    // adopting it wholesale (`...cloud`) would roll authoritative sections like cardInv/wallet back to
    // that earlier snapshot, silently resurrecting instances (cards/equipment) already consumed by a
    // mutation the client has already reconciled — the resurrected id has no server-side backing, so the
    // next action on it (e.g. fuse) 404s CARD_NOT_FOUND.
    if (cloud.rev < this.save.rev) return;
    const local = this.save;
    this.save = {
      ...cloud, // authoritative sections (equipped/flags/progress.cleared·stars/materials/pveUpgrades/cardInv/equipmentInv/wallet/...) + rev/accountId, all from cloud
      progress: {
        cleared: cloud.progress.cleared,
        stars: cloud.progress.stars,
        best: mergeBest(local.progress.best, cloud.progress.best),
      },
      // pvpDeck is local-only (never synced to server at all); preserve from local on every reconcile.
      ...(local.pvpDeck ? { pvpDeck: local.pvpDeck } : {}),
    };
    this.store.saveLocal(this.save);
  }
}

/** best: union of keys; shorter time / fewer leaked units wins (if one side is absent, take the present one). */
function mergeBest(
  a: Record<string, LevelRecord>,
  b: Record<string, LevelRecord>,
): Record<string, LevelRecord> {
  const out: Record<string, LevelRecord> = { ...b };
  for (const k of Object.keys(a)) {
    const cur = out[k];
    out[k] = cur ? betterRecord(a[k], cur) : a[k];
  }
  return out;
}

function betterRecord(x: LevelRecord, y: LevelRecord): LevelRecord {
  const tx = x.timeMs ?? Infinity;
  const ty = y.timeMs ?? Infinity;
  if (tx !== ty) return tx < ty ? x : y;
  const lx = x.leaked ?? Infinity;
  const ly = y.leaked ?? Infinity;
  return lx <= ly ? x : y;
}
