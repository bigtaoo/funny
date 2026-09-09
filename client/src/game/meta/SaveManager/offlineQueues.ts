// SaveManager's three offline settlement queues, extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛 + 拆分形态优先级") — same "no Core delegate,
// explicit host param" shape as CityScene/actions.ts and CityScene/data.ts.
//
// Why this is a real seam and not a line-count trick: everything here answers one question —
// "what has the player done that the server has not accepted yet, and how does it get settled?"
// The three persisted queues (`pending` clears, `pendingStamina` spends, `pendingFlags` writes)
// share one lifecycle: enqueue when a write cannot reach the server, drain right after the next
// successful pull, discard on a business error, keep on a network error. The PvE actions that
// fill them (spendStaminaForLevel/recordClear + the replay re-verification they trigger) come
// along because "deduct locally, settle or queue" is that same lifecycle seen from the caller's
// side, not a separate concern. What stays behind in SaveManager.ts is the other half: the local
// mirror, its subscribers, the optimistic flag/equip writes, and the bootstrap/refresh/logout
// orchestration that calls the flushers below.
//
// The 2026-09-09 pending-flag queue (see PENDING_FLAGS_KEY in ../SaveStore.ts) is what forced the
// issue: it pushed SaveManager.ts from 641 to 696 lines, and its baseline exception justified
// itself as the "single shared-state+business-logic root" shape "same as CityScene/core.ts" — an
// exception that was itself revoked on 2026-08-13 once "5 async network actions + 5 pure helpers"
// turned out to have plenty of extraction precedent. The same verdict applies here, so the
// exception was retired by splitting rather than renewed by bumping its line count.
//
// Every state member below MUST be declared as a getter on the host, never copied onto a throwaway
// object: reconcile() reassigns `save` wholesale, resetForLogout() reassigns all three queue arrays,
// and `api` itself gets swapped after construction (that is how the "flush under the departing
// account's still-valid token" path is driven). A plain property snapshot would keep mutating the
// array the departing account left behind, and would flush through whichever ApiClient the instance
// happened to be built with — same reasoning as CityScene/actions.ts's ActionsHost.me and
// RoomScene/views.ts's RoomViewHost.
import { ApiError, type ApiClient } from '../../../net/ApiClient';
import { replayToUploadFrames } from '../../../net/replayUpload';
import type { Replay } from '@nw/engine/types';
import type { SaveData } from '../SaveData';
import type { PendingClear, PendingStaminaSpend, SaveStore } from '../SaveStore';
import { replayIdFor } from '../ReplayStore';
import { serverNow } from '../../../net/serverClock';

// Stamina constants (A4) — mirrors server/metaserver/src/service/base.ts STAMINA_CAP/STAMINA_REGEN_MS,
// needed here so entering a level can deduct correctly even fully offline (no server round-trip available).
const STAMINA_CAP = 120;
const STAMINA_REGEN_MS = 6 * 60 * 1000; // 6 min per point

/**
 * What the queues need from SaveManager. Deliberately the whole working set rather than a narrower
 * per-function interface: every function below both reads the live save and writes it back through
 * persist()/adoptServer()/reconcile(), so a narrow interface would not reduce the coupling surface
 * — it would only hide it (same call made in GameRenderer/core.ts's events→input case).
 */
export interface OfflineQueuesHost {
  /** Live in-memory save. A getter, not a copy — reconcile() below reassigns SaveManager's field. */
  readonly save: SaveData;
  readonly store: SaveStore;
  /** Cloud client. A getter — resetForLogout()'s "flush under the departing token" path is exercised by
   *  swapping SaveManager's `api` after construction (test/save-manager.test.ts), so a copy would flush
   *  through the client this instance happened to be built with. */
  readonly api?: ApiClient | undefined;
  /** ReplayStore lookup for the L1 spot-check on an offline clear (§8.6); absent → skip verification. */
  readonly loadReplay?: ((id: string) => Replay | null) | undefined;
  /** Offline queue of clears awaiting settlement (PVE_INTEGRITY_PLAN §8.4). Getter — see file header. */
  readonly pending: PendingClear[];
  /** Offline queue of stamina spends awaiting server settlement (A4). Getter — see file header. */
  readonly pendingStamina: PendingStaminaSpend[];
  /** Flag writes the server never accepted, keyed by flag name (2026-09-09). Getter — see file header. */
  readonly pendingFlags: Record<string, boolean>;
  online(): boolean;
  persist(): void;
  adoptServer(save: SaveData): void;
  reconcile(cloudRaw: SaveData): void;
}

/**
 * Spend stamina to enter a level (A4, 2026-07-06): deducted the moment the player commits, not at clear,
 * so retreating or losing mid-level does not refund it. Deducts the local mirror immediately and
 * unconditionally — including fully offline, so the player sees the cost right away — then settles with
 * the server in the background (online) or queues for settlement on reconnect (offline / request failed).
 * Returns false without deducting anything when the (regen-adjusted) balance is below cost.
 */
export function spendStaminaForLevel(host: OfflineQueuesHost, levelId: string, cost: number): boolean {
  const regen = regenStamina(host);
  if (regen.current < cost) {
    host.save.stamina = regen; // still persist the regen catch-up even when entry is blocked
    host.persist();
    return false;
  }
  const current = regen.current - cost;
  const regenAt = regen.regenAt !== 0 ? regen.regenAt : current < STAMINA_CAP ? serverNow() + STAMINA_REGEN_MS : 0;
  host.save.stamina = { current, regenAt };
  host.persist();
  if (host.online()) {
    host.api!.pveEnter(levelId).then((res) => {
      host.save.stamina = res.stamina;
      host.persist();
    }).catch(() => enqueueStaminaSpend(host, { levelId, cost, ts: Date.now() }));
  } else {
    enqueueStaminaSpend(host, { levelId, cost, ts: Date.now() });
  }
  return true;
}

/** Apply natural regen to the local stamina mirror (same algorithm as server deductStamina/readStaminaSnapshot) without persisting; caller decides whether/how to save the result. */
function regenStamina(host: OfflineQueuesHost): { current: number; regenAt: number } {
  // serverNow() (P1-1): regenAt may hold a server-issued value (from a prior pveEnter response) —
  // comparing it against the client's raw local clock would under/over-count regen ticks by the
  // clock's drift each time this runs.
  const now = serverNow();
  let { current, regenAt } = host.save.stamina ?? { current: STAMINA_CAP, regenAt: 0 };
  if (current < STAMINA_CAP && regenAt > 0 && now >= regenAt) {
    const ticks = Math.floor((now - regenAt) / STAMINA_REGEN_MS) + 1;
    current = Math.min(STAMINA_CAP, current + ticks);
    regenAt = current >= STAMINA_CAP ? 0 : regenAt + ticks * STAMINA_REGEN_MS;
  }
  return { current, regenAt };
}

function enqueueStaminaSpend(host: OfflineQueuesHost, entry: PendingStaminaSpend): void {
  host.pendingStamina.push(entry);
  host.store.savePendingStamina(host.pendingStamina);
}

/** Flush the pending stamina-spend queue in order once back online: the local mirror is already deducted, so this only settles the server's authoritative copy (best-effort). */
export async function flushPendingStamina(host: OfflineQueuesHost): Promise<void> {
  if (!host.online()) return;
  while (host.pendingStamina.length > 0) {
    const head = host.pendingStamina[0]!;
    try {
      const res = await host.api!.pveEnter(head.levelId);
      host.save.stamina = res.stamina;
      host.persist();
      host.pendingStamina.shift();
      host.store.savePendingStamina(host.pendingStamina);
    } catch (e) {
      if (e instanceof ApiError) {
        // Business error (unknown level etc.): cannot be settled server-side; drop it rather than block the queue (local deduction already stands).
        host.pendingStamina.shift();
        host.store.savePendingStamina(host.pendingStamina);
        continue;
      }
      break; // network error: keep queue, retry next time
    }
  }
}

/** Remember a flag write the server has not accepted (yet), so flushPendingFlags() can retry it after the next pull. */
export function queuePendingFlag(host: OfflineQueuesHost, key: string, value: boolean): void {
  host.pendingFlags[key] = value;
  host.store.savePendingFlags(host.pendingFlags);
}

/**
 * Flush the pending flag-write queue once back online. Called right after reconcile() in
 * bootstrap()/refresh(), which is the moment that matters: reconcile has just replaced `flags` with
 * the cloud copy, so an entry the cloud already agrees with is confirmed (drop it) and every other
 * entry is a write the server genuinely never saw (re-push it, and re-apply it locally in the
 * meantime so the gate/screen that set it doesn't flip back while the PUT is in flight).
 *
 * Deliberately does NOT fall back to refresh() on failure the way setFlag does — refresh() is what
 * calls this method, and the entry simply stays queued for the next pull.
 */
export async function flushPendingFlags(host: OfflineQueuesHost): Promise<void> {
  if (!host.online()) return;
  for (const [key, value] of Object.entries(host.pendingFlags)) {
    if (host.save.flags[key] === value) {
      delete host.pendingFlags[key]; // the cloud copy we just reconciled already carries this write
      continue;
    }
    host.save.flags[key] = value;
    host.persist();
    try {
      const res = await host.api!.setFlag(key, value);
      host.reconcile(res.save);
      delete host.pendingFlags[key];
    } catch {
      break; // offline / server unreachable: keep the rest of the queue for the next pull
    }
  }
  host.store.savePendingFlags(host.pendingFlags);
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
export async function recordClear(host: OfflineQueuesHost, levelId: string, stars: number, replay?: Replay, stats?: Record<string, number>): Promise<void> {
  if (stars <= 0) return;
  // Optimistic local unlock (offline-first): write the clear into local progress immediately so the next
  // level is unlocked when returning to CampaignMap — no waiting for the server receipt (online recordClear
  // is fire-and-forget; the scene would already have been rebuilt before the receipt arrives and would read the stale value).
  // The server still settles authoritatively: online adoptServer / offline flush followed by reconcile overwrites
  // with the cloud cleared/stars in full; even a server-side rejection gets corrected (self-healing), so the optimistic value never drifts.
  applyLocalClear(host, levelId, stars);
  if (host.online()) {
    try {
      const res = await host.api!.pveClear(levelId, stars, {}, stats);
      host.adoptServer(res.save);
      if (res.needsReplay && res.verifyId && replay) {
        await verifyReplay(host, res.verifyId, replay);
      }
      return;
    } catch {
      // Online but request failed (network blip) → enqueue as fallback, flush next time
    }
  }
  enqueueClear(host, {
    levelId,
    stars,
    ts: Date.now(),
    ...(replay?.meta?.recordedAt !== undefined
      ? { replayId: replayIdFor(replay.meta.recordedAt) }
      : {}),
  });
}

/** Upload the replay to /pve/verify for re-calculation → adopt push-back (materials credited). Failure is silent (the server-side record stays pending). */
async function verifyReplay(host: OfflineQueuesHost, verifyId: string, replay: Replay): Promise<void> {
  try {
    const res = await host.api!.pveVerify(verifyId, replay.endFrame, replayToUploadFrames(replay));
    host.adoptServer(res.save);
  } catch {
    /* Network/re-calculation error → materials not credited this round; server-side record stays pending (does not block local flow) */
  }
}

/** Optimistically write a local clear: append to cleared (deduped) + take the higher stars value (clamped to 1|2|3). Local-only (progress is not uploaded). */
function applyLocalClear(host: OfflineQueuesHost, levelId: string, stars: number): void {
  const p = host.save.progress;
  if (!p.cleared.includes(levelId)) p.cleared.push(levelId);
  const s = Math.max(1, Math.min(3, Math.round(stars))) as 1 | 2 | 3;
  if ((p.stars[levelId] ?? 0) < s) p.stars[levelId] = s;
  host.persist();
}

function enqueueClear(host: OfflineQueuesHost, entry: PendingClear): void {
  host.pending.push(entry);
  host.store.savePending(host.pending);
}

/** Flush the pending-settlement queue in order once back online: adopt after each success; keep on network failure for next attempt, discard on business error. */
export async function flushPending(host: OfflineQueuesHost): Promise<void> {
  if (!host.online()) return;
  while (host.pending.length > 0) {
    const head = host.pending[0];
    try {
      const res = await host.api!.pveClear(head.levelId, head.stars, {});
      host.adoptServer(res.save);
      // L1 spot-check triggered: retrieve the local replay and upload for re-calculation (if evicted from ReplayStore, skip — materials not credited this round).
      if (res.needsReplay && res.verifyId && head.replayId && host.loadReplay) {
        const replay = host.loadReplay(head.replayId);
        if (replay) await verifyReplay(host, res.verifyId, replay);
      }
      host.pending.shift();
      host.store.savePending(host.pending);
    } catch (e) {
      if (e instanceof ApiError) {
        // Business error (level not unlocked / invalid parameters): this entry cannot be settled; discard it to avoid permanently blocking the queue.
        host.pending.shift();
        host.store.savePending(host.pending);
        continue;
      }
      break; // network error: keep queue, retry next time
    }
  }
}
