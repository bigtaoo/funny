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
import { replayIdFor } from './ReplayStore';
import type { PendingClear, SaveStore } from './SaveStore';

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
  }

  /** 当前内存存档（同步可读，UI 余额等只读自此，由服务器回推刷新）。 */
  get(): SaveData {
    return this.save;
  }

  /**
   * 改客户端同步段：mutator 直接改 draft（progress/materials/pveUpgrades/equipped/flags），
   * 立即落本地 + 安排防抖上行。权威段（wallet/inventory/gacha/pvp）不应在此改——以服务器回推为准。
   */
  update(mutator: (draft: SaveData) => void): void {
    mutator(this.save);
    this.store.saveLocal(this.save);
    this.dirty = true;
    this.schedulePush();
  }

  /** 设置单个 flag（收编 nw_seen_intro 等）。 */
  setFlag(key: string, value: boolean): void {
    this.update((d) => {
      d.flags[key] = value;
    });
  }

  getFlag(key: string): boolean {
    return this.save.flags[key] === true;
  }

  /**
   * 首次功能引导（ONBOARDING_DESIGN §4.1）：某功能页是否已看过首启引导。
   * 扁平键 `featSeen.<id>` 落在同步段 flags（Record<string,boolean>），无需改 SaveData schema。
   */
  featSeen(featureId: string): boolean {
    return this.save.flags[`featSeen.${featureId}`] === true;
  }

  /** 标记某功能引导已看过（看过/关掉后不再自动弹；页面「?」按钮可强制重看，不清此位）。 */
  markFeatSeen(featureId: string): void {
    this.setFlag(`featSeen.${featureId}`, true);
  }

  /**
   * 启动云同步：换 token → pull → reconcile → 必要时 push。
   * 任何网络/鉴权失败都被吞掉（保持本地可玩），仅返回是否成功联通。
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
      await this.flushPending(); // 离线攒的通关上线结算
      return true;
    } catch {
      // 离线 / 服务器不可达：留在本地，不报错。
      return false;
    }
  }

  /**
   * 主动拉取云端存档 + reconcile（不重新 auth，复用现有 token）。
   * 用于服务器权威段在客户端外被改写后刷新本地——如 ranked 局末 gameserver
   * 写了 `pvp`（elo/rank/streak），客户端据此即时刷新大厅段位，无需等下次 bootstrap。
   * 未联通则 no-op，不抛错。
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
      await this.flushPending(); // 重连后结算离线攒的通关
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 正式登录/注册后采纳会话（SA-3/SA-4）：token 已由 ApiClient 持有，此处把 accountId
   * 落本地并 pull + reconcile（单机攒的 PvE 进度并入云端，权威段以云端为准，§4.4）。
   * 与 bootstrap 的区别是不重新 auth（不用匿名 device 凭据换号）。未联通则 no-op。
   */
  async adoptSession(accountId: string): Promise<boolean> {
    this.save.accountId = accountId;
    this.store.saveLocal(this.save);
    return this.refresh();
  }

  /**
   * 采纳服务器经济操作（商店/盲盒/充值/广告）回推的权威存档（S2）。钱包/库存/盲盒/pvp
   * 等权威段以服务器为准，客户端同步段合并本地。与 refresh 不同的是直接吃回执，不再发请求。
   */
  adoptServer(save: SaveData): void {
    this.reconcile(save);
  }

  // ── PvE 服务器权威（PVE_INTEGRITY_PLAN §8）────────────────────────────
  // progress/materials/pveUpgrades 是服务器权威；通关/升级走 /pve/* 端点，回推后 adopt。
  // 离线（无 token）：通关入队待结算（不改本地权威值）；升级禁用。

  /** 是否联通可写服务器权威段（有 api + token）。场景据此做在线门控。 */
  online(): boolean {
    return !!this.api?.hasToken();
  }

  /** 离线待结算通关队列（只读副本，供 UI 显示「待结算」）。 */
  getPendingClears(): PendingClear[] {
    return this.pending.slice();
  }

  /**
   * 记录一次通关（stars≥1）。在线 → POST /pve/clear 立即结算并 adopt 回推；
   * 离线 / 请求失败 → 入队（不改本地权威值），上线后 flush。
   * L1 抽检（§8.6 第 3 步）：服务器回 `needsReplay` 时材料暂扣，用本局录像补传 /pve/verify 复算入账。
   */
  /**
   * @param stats 本局成就计数（achievementStatDelta 产出）；S9-3b，普通通关喂入服务器计数。
   */
  async recordClear(levelId: string, stars: number, replay?: Replay, stats?: Record<string, number>): Promise<void> {
    if (stars <= 0) return;
    // 乐观本地解锁（离线优先）：立刻把通关写进本地 progress，回到 CampaignMap 时下一关即解锁，
    // 不必干等服务器回执（在线时 recordClear 是 fire-and-forget，回执前场景已重建会读到旧值）。
    // 服务器仍权威结算：在线 adoptServer / 离线 flush 后 reconcile 用云端 cleared/stars 整体覆盖回填，
    // 即便服务器判负也会被纠正（自愈），故乐观值不会造成漂移。
    this.applyLocalClear(levelId, stars);
    if (this.online()) {
      try {
        const res = await this.api!.pveClear(levelId, stars, this.save.unitLevels, stats);
        this.adoptServer(res.save);
        if (res.needsReplay && res.verifyId && replay) {
          await this.verifyReplay(res.verifyId, replay);
        }
        return;
      } catch {
        // 在线但请求失败（网络抖动）→ 入队兜底，下次 flush
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

  /** 上传录像走 /pve/verify 复算 → adopt 回推（含发材料）。失败静默（服务器侧记录仍 pending）。 */
  private async verifyReplay(verifyId: string, replay: Replay): Promise<void> {
    try {
      const res = await this.api!.pveVerify(verifyId, replay.endFrame, replayToUploadFrames(replay));
      this.adoptServer(res.save);
    } catch {
      /* 网络/复算异常 → 本轮不入账，服务器侧记录留 pending（不卡本地流程） */
    }
  }

  /**
   * @deprecated S3-2 per-stat 升级。S12 起单位养成改集卡合成，改用 {@link merge}。
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

  /**
   * 单位卡合成（S12）：5 张 N 级卡 → 1 张 N+1 级。仅在线，服务器权威扣库存。
   * 卡片不足 / 非法参数 / 离线 → 返回 false，不改本地。
   */
  async merge(unitId: string, level: number): Promise<boolean> {
    if (!this.online()) return false;
    try {
      const res = await this.api!.pveMerge(unitId, level);
      this.adoptServer(res.save);
      return true;
    } catch {
      return false;
    }
  }

  /** 乐观写本地通关：cleared 去重追加 + stars 取较大（夹到 1|2|3）。仅落本地（progress 不上行）。 */
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

  /** 上线后按序 flush 待结算队列：每条成功后 adopt；网络失败保留待下次，业务错误丢弃。 */
  private async flushPending(): Promise<void> {
    if (!this.online()) return;
    while (this.pending.length > 0) {
      const head = this.pending[0];
      try {
        const res = await this.api!.pveClear(head.levelId, head.stars, this.save.unitLevels);
        this.adoptServer(res.save);
        // L1 抽中：取回本地录像补传复算（已被 ReplayStore 淘汰则跳过，材料本轮不入账）。
        if (res.needsReplay && res.verifyId && head.replayId && this.loadReplay) {
          const replay = this.loadReplay(head.replayId);
          if (replay) await this.verifyReplay(res.verifyId, replay);
        }
        this.pending.shift();
        this.store.savePending(this.pending);
      } catch (e) {
        if (e instanceof ApiError) {
          // 业务错误（关卡未解锁 / 参数非法）：该条无法结算，丢弃避免永久卡队列。
          this.pending.shift();
          this.store.savePending(this.pending);
          continue;
        }
        break; // 网络错误：保留队列，下次再试
      }
    }
  }

  /** 立即清空防抖、强制上行（场景切换 / 退出前调用）。 */
  async flush(): Promise<void> {
    if (this.pushTimer != null) {
      this.clearTimer(this.pushTimer);
      this.pushTimer = null;
    }
    await this.push();
  }

  // ── 内部 ────────────────────────────────────────────────

  private schedulePush(): void {
    if (!this.api?.hasToken()) return; // 未联通 → 只本地
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
      // putSave 返回即代表服务器可达（含 409 冲突）→ 复位失败计数。
      this.syncFailStreak = 0;
      this.syncErrorNotified = false;
      if (res.kind === 'ok') {
        this.adoptCloud(res.save);
      } else {
        // 409：合并云端后重试一次（用合并后的新 rev）。
        this.reconcile(res.save);
        const retry = await this.api.putSave(this.save.rev, extractSyncPatch(this.save));
        if (retry.kind === 'ok') this.adoptCloud(retry.save);
        else this.reconcile(retry.save); // 仍冲突 → 采纳云端，下次再推
      }
    } catch {
      this.dirty = true; // 网络抖动 → 标脏，下次再试
      // 连续失败到阈值才提示一次（离线优先下偶发失败不打扰，持续失败才打破沉默）。
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
   * 用云端值覆盖本地（push 成功回执）。
   * putSave 只改 equipped/flags，不改 progress；若本地有云端尚未确认的通关（in-flight pveClear
   * 的 applyLocalClear 或网络抖动入队待结算），保留它们，防止 push 回执把乐观写冲掉。
   * best 是纯本地展示统计（永不上云）→ 并集取优，与 reconcile 保持一致。
   */
  private adoptCloud(cloud: SaveData): void {
    const local = this.save;
    // 本地有而云端无的通关：来自 in-flight pveClear（applyLocalClear 已写但服务器尚未落库）。
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
    };
    this.store.saveLocal(this.save);
  }

  /**
   * reconcile：服务器权威段一律以云端为准。PVE_INTEGRITY_PLAN §8 起 progress（cleared/stars）/
   * materials / pveUpgrades 也是服务器权威 → 取云端（不再并集/取较大）；仅 equipped/flags 是客户端
   * 同步段做本地覆盖。progress.best 是本地展示统计（永不上云、无奖励含义）→ 并集取优保留本地。
   * rev/accountId 取云端。
   */
  private reconcile(cloud: SaveData): void {
    const local = this.save;
    this.save = {
      ...cloud, // 权威段（含 progress.cleared/stars / materials / pveUpgrades）+ rev/accountId 取云端
      progress: {
        cleared: cloud.progress.cleared,
        stars: cloud.progress.stars,
        best: mergeBest(local.progress.best, cloud.progress.best),
      },
      equipped: { ...cloud.equipped, ...local.equipped },
      flags: { ...cloud.flags, ...local.flags },
    };
    this.store.saveLocal(this.save);
    // equipped/flags 本地可能与云端有别（本地覆盖），标脏待下次上行。
    this.dirty = true;
  }
}

/** best：并集键，时间更短 / 漏怪更少者胜（缺则取存在的一方）。 */
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
