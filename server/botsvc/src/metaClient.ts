// Bots log in exactly like a real Web/CrazyGames client: metaserver's public anonymous device-login
// (contracts/openapi.yml POST /auth/device), no bot-specific account API (BOTSVC_DESIGN §3.1/B2).
// The PvE calls are the client's own (contracts/openapi/paths/pve.yml, save.yml) — BOTSVC_DESIGN §3.5.
import type { CardInstance, EquipmentInstance } from '@nw/shared';
import { envelopeError } from './apiError';
import type { UploadFrame } from './pve';

export interface DeviceLoginResult {
  token: string;
  accountId: string;
  isNew: boolean;
  gatewayUrl?: string;
}

/** The `/save` fields a PvE run reads: where the bot is on the map, and the cards the judge will replay with. */
export interface BotSaveView {
  progress: { cleared: string[]; stars: Record<string, number> };
  cardInv?: Record<string, CardInstance> | null;
  equipmentInv?: Record<string, EquipmentInstance> | null;
}

export interface PveClearResult {
  capped: boolean;
  /** Picked for a spot check: rewards wait for /pve/verify with `verifyId`. */
  needsReplay?: boolean;
  verifyId?: string;
}

export class MetaClient {
  constructor(private readonly baseUrl: string) {}

  async deviceLogin(deviceId: string): Promise<DeviceLoginResult> {
    const res = await fetch(`${this.baseUrl}/auth/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });
    if (!res.ok) throw new Error(`device-login failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { ok: boolean; data: DeviceLoginResult };
    if (!body.ok) throw new Error('device-login: server returned ok:false');
    return body.data;
  }

  private async call<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await res.json()) as { ok: boolean; data?: T; error?: unknown };
    if (!parsed.ok) throw envelopeError(parsed.error, `meta call failed: ${method} ${path} (${res.status})`);
    return parsed.data as T;
  }

  async getSave(token: string): Promise<BotSaveView> {
    return (await this.call<{ save: BotSaveView }>('GET', '/save', token)).save;
  }

  /** Spends the level's stamina (no refund on a loss), exactly when a player commits to a level. */
  async pveEnter(token: string, levelId: string): Promise<void> {
    await this.call('POST', '/pve/enter', token, { levelId });
  }

  pveClear(token: string, levelId: string, stars: number, stats: Record<string, number>): Promise<PveClearResult> {
    return this.call<PveClearResult>('POST', '/pve/clear', token, { levelId, stars, stats });
  }

  async pveVerify(token: string, verifyId: string, endFrame: number, frames: UploadFrame[]): Promise<{ verified: boolean }> {
    return this.call<{ verified: boolean }>('POST', '/pve/verify', token, { verifyId, endFrame, frames });
  }
}
