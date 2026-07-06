// Cloud sync orchestration (S0-5). Offline-first + server-authoritative:
//   · On startup call loadLocal (immediately playable, works without network).
//   · bootstrap(): auth → pull → reconcile by rev/section authority → push if needed.
//   · update(): mutate the client-sync section → saveLocal immediately → debounce 2s then push.
//   · push sends If-Match: rev; 409 → pull-merge (server-authoritative sections use server value, progress union-merged) then retry once.
// Network unavailable / ApiClient not configured → silently degrade to local-only (no error thrown to caller).

import type { AuthCredential } from '../../platform/IPlatform';
import { ApiError, type ApiClient } from '../../net/ApiClient';
import { replayToUploadFrames } from '../../net/replayUpload';
import type { Replay } from '../types';
import {
  extractSyncPatch,
  type LevelRecord,
  type SaveData,
} from './SaveData';
import { migrate } from './migrate';
import { replayIdFor } from './ReplayStore';
import type { PendingClear, PendingStaminaSpend, SaveStore } from './SaveStore';

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
  /** Upload debounce window (ms), default 2000 (§3.3). */
  debounceMs?: number;
  /**
   * Account profile returned from the cloud; called back after bootstrap/refresh pulls it. Used for client persistence / UI refresh / online connectivity.
   * `gatewayUrl`: the control-plane WS address delivered by the server (not hardcoded on the client; see ApiClient.AuthResult).
   */
  onProfile?: (profile: { displayName?: string; publicId?: string; gatewayUrl?: string }) => void;
  /** Retrieve a local replay (ReplayStore); during L1 spot-check, offline flush uses replayId to fetch and upload for server re-validation (§8.6). */
  loadReplay?: (id: string) => Replay | null;
  /** Inject timer functions (for testing); defaults to globalThis. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /**
   * Called once when cloud save uploads fail consecutively beyond the threshold (notifies the player that progress may not be synced). Resets after one successful upload,
   * so it will not spam every 2s. Background sync is silent under offline-first; this only breaks silence on sustained failure.
   */
  onSyncError?: () => void;
}

/** Number of consecutive upload failures before notifying the player (avoids reacting to one-off network blips). */
const SYNC_FAIL_THRESHOLD = 3;

export class SaveManager {
  private save: SaveData;
  private readonly store: SaveStore;
  private readonly api?: ApiClient;
  private readonly getCredential?: () => Promise<AuthCredential>;
  private readonly onProfile?: (profile: { displayName?: string; publicId?: string; gatewayUrl?: string }) => void;
  private readonly loadReplay?: (id: string) => Replay | null;
  private readonly onSyncError?: () => void;
  private syncFailStreak = 0;     // consecutive upload failure count
  private syncErrorNotified = false; // whether the player has already been notified in the current failure streak (to avoid spamming)
  private readonly debounceMs: number;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  private pushTimer: unknown = null;
  private pushing = false;
  private dirty = false; // local changes within the debounce window not yet uploaded
  private pending: PendingClear[]; // offline queue of clears awaiting settlement (PVE_INTEGRITY_PLAN §8.4)
  private pendingStamina: PendingStaminaSpend[]; // offline queue of stamina spends awaiting server settlement (A4)

  constructor(opts: SaveManagerOpts) {
    this.store = opts.store;
    this.api = opts.api;
    this.getCredential = opts.getCredential;
    this.onProfile = opts.onProfile;
    this.loadReplay = opts.loadReplay;
    this.onSyncError = opts.onSyncError;
    this.debounceMs = opts.debounceMs ?? 2000;
    this.setTimer =
      opts.setTimer ?? ((cb, ms) => (globalThis as typeof globalThis).setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => (globalThis as typeof globalThis).clearTimeout(h as never));
    this.save = this.store.loadLocal();
    this.pending = this.store.loadPending();
    this.pendingStamina = this.store.loadPendingStamina();
  }

  /** Current in-memory save (synchronously readable; UI balances etc. read from here and are refreshed by server push-back). */
  get(): SaveData {
    return this.save;
  }

  /**
   * Mutate the client-sync section: the mutator modifies the draft directly (progress/materials/pveUpgrades/equipped/flags),
   * saves locally immediately, and schedules a debounced upload. Authoritative sections (wallet/inventory/gacha/pvp)
   * must not be mutated here — they are governed by server push-back.
   */
  update(mutator: (draft: SaveData) => void): void {
    mutator(this.save);
    this.store.saveLocal(this.save);
    this.dirty = true;
    this.schedulePush();
  }

  /** Mutate local-only fields (not in SyncPatch) and save locally without triggering a server push. */
  patchLocal(patch: Pick<Partial<import('./SaveData').SaveData>, 'pvpDeck'>): void {
    Object.assign(this.save, patch);
    this.store.saveLocal(this.save);
  }

  /** Set a single flag (e.g. nw_seen_intro). */
  setFlag(key: string, value: boolean): void {
    this.update((d) => {
      d.flags[key] = value;
    });
  }

  getFlag(key: string): boolean {
    return this.save.flags[key] === true;
  }

  /**
   * First-time feature onboarding (ONBOARDING_DESIGN §4.1): whether the player has already seen the onboarding tour for a given feature page.
   * The flat key `featSeen.<id>` is stored in the sync-section flags (Record<string,boolean>); no SaveData schema change required.
   */
  featSeen(featureId: string): boolean {
    return this.save.flags[`featSeen.${featureId}`] === true;
  }

  /** Mark a feature's onboarding tour as seen (will no longer auto-popup after being seen/dismissed; the page "?" button can force a replay without clearing this flag). */
  markFeatSeen(featureId: string): void {
    this.setFlag(`featSeen.${featureId}`, true);
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
      this.onProfile?.({
        displayName: cloud.displayName,
        publicId: auth.publicId ?? cloud.publicId,
        gatewayUrl: auth.gatewayUrl ?? cloud.gatewayUrl,
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
      this.onProfile?.({
        displayName: cloud.displayName,
        publicId: cloud.publicId,
        gatewayUrl: cloud.gatewayUrl,
      });
      await this.flushPending(); // settle clears queued offline after reconnection
      await this.flushPendingStamina(); // settle stamina spends queued offline after reconnection
      return true;
    } catch {
      return false;
    }
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
   * Adopt an authoritative save pushed back by a server-side economy operation (shop/gacha/recharge/ad) (S2).
   * Authoritative sections (wallet/inventory/gacha/pvp etc.) use the server value; client-sync sections are merged from local.
   * Unlike refresh, this directly consumes the receipt without issuing an additional request.
   */
  adoptServer(save: SaveData): void {
    this.reconcile(save);
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
    const regenAt = regen.regenAt !== 0 ? regen.regenAt : current < STAMINA_CAP ? Date.now() + STAMINA_REGEN_MS : 0;
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
    const now = Date.now();
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

  /** Cancel the debounce timer immediately and force an upload (call before scene transitions / exit). */
  async flush(): Promise<void> {
    if (this.pushTimer != null) {
      this.clearTimer(this.pushTimer);
      this.pushTimer = null;
    }
    await this.push();
  }

  // ── Internal ────────────────────────────────────────────────

  private schedulePush(): void {
    if (!this.api?.hasToken()) return; // not connected → local-only
    if (this.pushTimer != null) this.clearTimer(this.pushTimer);
    this.pushTimer = this.setTimer(() => {
      this.pushTimer = null;
      void this.push();
    }, this.debounceMs);
  }

  private async push(): Promise<void> {
    if (!this.api?.hasToken() || this.pushing || !this.dirty) return;
    this.pushing = true;
    try {
      this.dirty = false;
      const res = await this.api.putSave(this.save.rev, extractSyncPatch(this.save));
      // putSave returning (including 409 conflict) means the server is reachable → reset failure streak.
      this.syncFailStreak = 0;
      this.syncErrorNotified = false;
      if (res.kind === 'ok') {
        this.adoptCloud(res.save);
      } else {
        // 409: merge from cloud then retry once (using the new rev after reconciliation).
        this.reconcile(res.save);
        const retry = await this.api.putSave(this.save.rev, extractSyncPatch(this.save));
        if (retry.kind === 'ok') this.adoptCloud(retry.save);
        else this.reconcile(retry.save); // still conflicting → adopt cloud, push again next time
      }
    } catch {
      this.dirty = true; // network blip → mark dirty, retry next time
      // Notify only after consecutive failures reach the threshold (sporadic failures are silent under offline-first; sustained failure breaks the silence).
      this.syncFailStreak++;
      if (this.syncFailStreak >= SYNC_FAIL_THRESHOLD && !this.syncErrorNotified) {
        this.syncErrorNotified = true;
        this.onSyncError?.();
      }
    } finally {
      this.pushing = false;
    }
  }

  /**
   * Overwrite local state with cloud values (on a successful push receipt).
   * putSave only changes equipped/flags, not progress; if local has clears not yet confirmed by the cloud
   * (applyLocalClear from an in-flight pveClear, or entries queued pending settlement after a network blip),
   * preserve them to prevent the push receipt from overwriting optimistic writes.
   * best is a purely local display stat (never uploaded) → take the union of better values, consistent with reconcile.
   */
  private adoptCloud(cloudRaw: SaveData): void {
    // Cloud saves are adopted verbatim; run them through migrate/fillDefaults so a document written by
    // an older client (missing client-only fields like cardInv/equipmentInv added in later versions) is
    // backfilled to the current shape. Without this, `Object.values(cardInv)` on campaign start throws
    // "can't convert undefined to object".
    const cloud = migrate(cloudRaw);
    const local = this.save;
    // Clears present locally but absent from cloud: from an in-flight pveClear (applyLocalClear already written but not yet persisted by the server).
    const localExtra = local.progress.cleared.filter((id) => !cloud.progress.cleared.includes(id));
    this.save = {
      ...cloud,
      progress: {
        cleared: localExtra.length > 0 ? [...cloud.progress.cleared, ...localExtra] : cloud.progress.cleared,
        stars: localExtra.reduce((acc, id) => {
          const v = local.progress.stars[id];
          return v !== undefined ? { ...acc, [id]: Math.max((acc[id] ?? 0) as number, v) as 1 | 2 | 3 } : acc;
        }, { ...cloud.progress.stars } as Record<string, 1 | 2 | 3>),
        best: mergeBest(local.progress.best, cloud.progress.best),
      },
      // pvpDeck is local-only (never synced to server); preserve from local.
      ...(local.pvpDeck ? { pvpDeck: local.pvpDeck } : {}),
    };
    this.store.saveLocal(this.save);
  }

  /**
   * reconcile: all server-authoritative sections use the cloud value. Since PVE_INTEGRITY_PLAN §8,
   * progress (cleared/stars) / materials / pveUpgrades are also server-authoritative → take cloud
   * (no longer union-merged or max-taken); only equipped/flags are client-sync sections and are
   * overwritten with local values. progress.best is a local display stat (never uploaded, carries no
   * reward semantics) → union of better values preserves local data.
   * rev/accountId taken from cloud.
   */
  private reconcile(cloudRaw: SaveData): void {
    // Normalize the raw cloud document to the current shape before adopting (see adoptCloud): an older
    // account's save may lack client-only fields (cardInv/equipmentInv), which would otherwise crash the
    // campaign start path. migrate is idempotent for a complete save.
    const cloud = migrate(cloudRaw);
    const local = this.save;
    this.save = {
      ...cloud, // authoritative sections (including progress.cleared/stars / materials / pveUpgrades) + rev/accountId from cloud
      progress: {
        cleared: cloud.progress.cleared,
        stars: cloud.progress.stars,
        best: mergeBest(local.progress.best, cloud.progress.best),
      },
      equipped: { ...cloud.equipped, ...local.equipped },
      flags: { ...cloud.flags, ...local.flags },
      // pvpDeck is local-only (never synced to server); preserve from local on every reconcile.
      ...(local.pvpDeck ? { pvpDeck: local.pvpDeck } : {}),
    };
    this.store.saveLocal(this.save);
    // equipped/flags may differ from cloud (local overwrites); mark dirty for the next upload.
    this.dirty = true;
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
