// worldsvc → meta 内部调用（S8-5：拍卖场材料 / S8 owner：玩家档案）。
// meta 内部 HTTP（/internal/materials/* · /internal/profile），X-Internal-Key 鉴权。
// 未配置 NW_META_INTERNAL_URL → available=false → 拍卖材料交易 + owner 昵称不可用。

import { internalHeaders, SlgError, type EquipmentInstance, type GearLoadout } from '@nw/shared';

export interface PlayerProfile {
  publicId?: string;
  displayName?: string;
}

/** 围攻引擎权威计算所需的攻方养成快照（E8，/internal/save-fields）。 */
export interface SaveFields {
  pveUpgrades: Record<string, number>;
  unitLevels: Record<string, number>;
  gear: GearLoadout;
  equipmentInv: Record<string, EquipmentInstance>;
}

export interface WorldMetaClient {
  readonly available: boolean;
  /** 扣除材料（挂拍卖 / 取消返还的逆操作）。insufficient → 抛含 INSUFFICIENT_RESOURCES 的 Error。 */
  deductMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void>;
  /** 发放材料（拍卖成交给买家 / 取消/过期返还给卖家）。best-effort，失败 log 不回滚。 */
  grantMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void>;
  /** 取玩家公开档案（publicId / displayName）。失败返回 null，调用方降级不展示昵称。 */
  getProfile(accountId: string): Promise<PlayerProfile | null>;
  /** 取攻方养成快照（围攻引擎权威计算，E8）。失败返回 null → 引擎降级无装备计算（不阻断行军）。 */
  getSaveFields(accountId: string): Promise<SaveFields | null>;
  /** 装备挂拍托管：移出卖方库存，返回实例快照（存进挂单 doc）。穿戴中/锁定/不存在 → 抛 SlgError。 */
  escrowEquipment(accountId: string, instanceId: string, orderId: string): Promise<EquipmentInstance>;
  /** 装备转移/退回：把实例快照写入目标账号库存（成交给买方 / 撤单过期退卖方）。best-effort，失败 log 不回滚。 */
  grantEquipment(accountId: string, instance: EquipmentInstance, orderId: string): Promise<void>;
  /** 授予称号（S10，SLG 赛季结算 → meta 写入）。best-effort，失败 log 不阻断结算。 */
  grantTitle(accountId: string, titleId: string): Promise<void>;
}

export class HttpWorldMetaClient implements WorldMetaClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async deductMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void> {
    if (!this.baseUrl) throw new Error('meta service not configured');
    const res = await fetch(`${this.baseUrl}/internal/materials/deduct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
      body: JSON.stringify({ accountId, material, qty, orderId }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `deductMaterial failed: ${res.status}`);
    }
  }

  async grantMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/internal/materials/grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
        body: JSON.stringify({ accountId, material, qty, orderId }),
      });
    } catch (e) {
      console.error('[worldsvc] meta.grantMaterial failed', { accountId, material, qty, orderId, err: (e as Error).message });
    }
  }

  async getProfile(accountId: string): Promise<PlayerProfile | null> {
    if (!this.baseUrl) return null;
    try {
      const res = await fetch(
        `${this.baseUrl}/internal/profile?accountId=${encodeURIComponent(accountId)}`,
        { headers: internalHeaders('worldsvc', this.internalKey) },
      );
      if (!res.ok) return null;
      return (await res.json()) as PlayerProfile;
    } catch {
      return null;
    }
  }

  async getSaveFields(accountId: string): Promise<SaveFields | null> {
    if (!this.baseUrl) return null;
    try {
      const res = await fetch(
        `${this.baseUrl}/internal/save-fields?accountId=${encodeURIComponent(accountId)}`,
        { headers: internalHeaders('worldsvc', this.internalKey) },
      );
      if (!res.ok) return null;
      return (await res.json()) as SaveFields;
    } catch {
      return null;
    }
  }

  async escrowEquipment(accountId: string, instanceId: string, orderId: string): Promise<EquipmentInstance> {
    if (!this.baseUrl) throw new Error('meta service not configured');
    const res = await fetch(`${this.baseUrl}/internal/equipment/escrow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
      body: JSON.stringify({ accountId, instanceId, orderId }),
    });
    const body = (await res.json().catch(() => ({}))) as { instance?: EquipmentInstance; code?: string; error?: string };
    if (!res.ok || !body.instance) {
      // 把 meta 的装备错误码透传为 SlgError（httpApi 据 ERROR_HTTP_STATUS 映射 HTTP）。
      const code = body.code;
      if (code === 'EQUIP_LOCKED' || code === 'EQUIP_IN_USE' || code === 'EQUIP_NOT_FOUND') throw new SlgError(code);
      throw new SlgError('BAD_REQUEST', body.error ?? `escrowEquipment failed: ${res.status}`);
    }
    return body.instance;
  }

  async grantEquipment(accountId: string, instance: EquipmentInstance, orderId: string): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/internal/equipment/grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
        body: JSON.stringify({ accountId, instance, orderId }),
      });
    } catch (e) {
      console.error('[worldsvc] meta.grantEquipment failed', { accountId, instanceId: instance.id, orderId, err: (e as Error).message });
    }
  }

  async grantTitle(accountId: string, titleId: string): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/internal/title/grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
        body: JSON.stringify({ accountId, titleId }),
      });
    } catch (e) {
      console.error('[worldsvc] meta.grantTitle failed', { accountId, titleId, err: (e as Error).message });
    }
  }
}

export const nullWorldMetaClient: WorldMetaClient = {
  available: false,
  async deductMaterial() { throw new Error('meta service not configured'); },
  async grantMaterial() { /* no-op */ },
  async getProfile() { return null; },
  async getSaveFields() { return null; },
  async escrowEquipment() { throw new Error('meta service not configured'); },
  async grantEquipment() { /* no-op */ },
  async grantTitle() { /* no-op */ },
};
