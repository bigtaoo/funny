// 云同步编排（S0-5）。离线优先 + 服务器权威：
//   · 启动 loadLocal（立即可玩，断网无碍）。
//   · bootstrap()：auth → pull → 按 rev/段权威 reconcile → 必要时 push。
//   · update()：改客户端同步段 → 立即 saveLocal → 防抖 2s 上行 push。
//   · push 带 If-Match: rev；409 → pull-merge（服务器权威段以服务器为准，progress 取并集）再重试一次。
// 网络不可用 / 未配 ApiClient → 静默退化为纯本地（不抛错给调用方）。

import type { AuthCredential } from '../../platform/IPlatform';
import type { ApiClient } from '../../net/ApiClient';
import {
  extractSyncPatch,
  type LevelRecord,
  type SaveData,
} from './SaveData';
import type { SaveStore } from './SaveStore';

export interface SaveManagerOpts {
  store: SaveStore;
  /** 云客户端；缺省 → 纯本地（离线优先）。 */
  api?: ApiClient;
  /** 取平台匿名凭据（S0-4）；配了 api 才需要。 */
  getCredential?: () => Promise<AuthCredential>;
  /** 上行防抖窗口（ms），默认 2000（§3.3）。 */
  debounceMs?: number;
  /**
   * 云端回带的账号资料；bootstrap/refresh 拉到后回调。用于客户端持久化 / 刷新 UI / 联网。
   * `gatewayUrl`：服务器下发的控制面 WS 地址（客户端不硬编码，见 ApiClient.AuthResult）。
   */
  onProfile?: (profile: { displayName?: string; publicId?: string; gatewayUrl?: string }) => void;
  /** 注入定时器（测试用）；默认走 globalThis。 */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export class SaveManager {
  private save: SaveData;
  private readonly store: SaveStore;
  private readonly api?: ApiClient;
  private readonly getCredential?: () => Promise<AuthCredential>;
  private readonly onProfile?: (profile: { displayName?: string; publicId?: string; gatewayUrl?: string }) => void;
  private readonly debounceMs: number;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  private pushTimer: unknown = null;
  private pushing = false;
  private dirty = false; // 防抖窗口内有未上行的本地改动

  constructor(opts: SaveManagerOpts) {
    this.store = opts.store;
    this.api = opts.api;
    this.getCredential = opts.getCredential;
    this.onProfile = opts.onProfile;
    this.debounceMs = opts.debounceMs ?? 2000;
    this.setTimer =
      opts.setTimer ?? ((cb, ms) => (globalThis as typeof globalThis).setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => (globalThis as typeof globalThis).clearTimeout(h as never));
    this.save = this.store.loadLocal();
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
    } finally {
      this.pushing = false;
    }
  }

  /** 用云端值整体覆盖本地（push 成功 / 首次 pull 且本地无独有改动时）。 */
  private adoptCloud(cloud: SaveData): void {
    this.save = cloud;
    this.store.saveLocal(this.save);
  }

  /**
   * reconcile：服务器权威段一律以云端为准；客户端同步段做合并（progress 并集、
   * materials/pveUpgrades 取较大、equipped/flags 本地覆盖），rev/accountId 取云端。
   */
  private reconcile(cloud: SaveData): void {
    const local = this.save;
    this.save = {
      ...cloud, // 权威段 + rev/accountId/updatedAt/version 取云端
      progress: {
        cleared: unionStr(local.progress.cleared, cloud.progress.cleared),
        stars: mergeMax(local.progress.stars, cloud.progress.stars) as Record<string, 1 | 2 | 3>,
        best: mergeBest(local.progress.best, cloud.progress.best),
      },
      materials: mergeMax(local.materials, cloud.materials),
      pveUpgrades: mergeMax(local.pveUpgrades, cloud.pveUpgrades),
      equipped: { ...cloud.equipped, ...local.equipped },
      flags: { ...cloud.flags, ...local.flags },
    };
    this.store.saveLocal(this.save);
    // 合并后本地若与云端有别（并集/较大造成），标脏待下次上行。
    this.dirty = true;
  }
}

function unionStr(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

function mergeMax(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...b };
  for (const k of Object.keys(a)) {
    out[k] = Math.max(a[k], b[k] ?? -Infinity);
  }
  return out;
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
