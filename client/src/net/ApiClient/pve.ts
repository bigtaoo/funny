// PvE server authority + replay sharing + match history/replay retrieval.
import type { SaveData, EquipmentInstance } from '../../game/meta/SaveData';
import { packReplayBlob, unpackReplayBlob } from '../replayCompress';
import { type Constructor, type ApiClientBaseCtor } from './base';
import type { ServerReplay, MatchHistoryEntry } from './types';

export interface PveApi {
  pveClear(
    levelId: string,
    stars: number,
    unitLevels?: Record<string, number>,
    stats?: Record<string, number>,
  ): Promise<{
    save: SaveData;
    granted: Record<string, number>;
    capped: boolean;
    needsReplay?: boolean;
    verifyId?: string;
    grantedEquipment?: EquipmentInstance;
  }>;
  createReplayShare(roomId: string): Promise<{ shareId: string }>;
  getReplayByShare(shareId: string): Promise<{ replay: unknown }>;
  createStateReplayShare(blob: unknown): Promise<{ shareCode: string }>;
  getStateReplayShare(shareCode: string): Promise<{ blob: unknown }>;
  pveVerify(
    verifyId: string,
    endFrame: number,
    frames: { frame: number; cmds: { side: number; commands: string }[] }[],
  ): Promise<{ save: SaveData; granted: Record<string, number>; capped: boolean; verified: boolean; grantedEquipment?: EquipmentInstance }>;
  pveUpgrade(upgradeId: string): Promise<{ save: SaveData }>;
  purchaseStamina(): Promise<{ stamina: { current: number; regenAt: number } }>;
  pveEnter(levelId: string): Promise<{ stamina: { current: number; regenAt: number } }>;
  getMatchHistory(limit?: number): Promise<MatchHistoryEntry[]>;
  getMatchReplay(roomId: string): Promise<ServerReplay>;
}

export function PveMixin<TBase extends ApiClientBaseCtor>(Base: TBase): TBase & Constructor<PveApi> {
  return class extends Base {
    // ── PvE server authority (PVE_INTEGRITY_PLAN §8, requires login token) ─────────────
    // progress/stars/materials/pveUpgrades are server-authoritative fields; level completion and upgrades go through these two endpoints,
    // which return the full authoritative SaveData (client adopts the mirror). Only callable when online.

    /**
     * PvE level-clear settlement: server validates the unlock → grants materials + cards within the daily cap → writes progress/stars → pushes back.
     * L1 sampling check (§8.6 step 3): when the request is sampled, returns `needsReplay + verifyId` (materials held back); the caller must submit the replay via {@link pveVerify} for re-computation and crediting.
     * `unitLevels` is the client-side unit blueprint snapshot at game start (L0 anomaly detection, S12).
     */
    async pveClear(
      levelId: string,
      stars: number,
      unitLevels?: Record<string, number>,
      stats?: Record<string, number>,
    ): Promise<{
      save: SaveData;
      granted: Record<string, number>;
      capped: boolean;
      needsReplay?: boolean;
      verifyId?: string;
      grantedEquipment?: EquipmentInstance;
    }> {
      return this.post<{
        save: SaveData;
        granted: Record<string, number>;
        capped: boolean;
        needsReplay?: boolean;
        verifyId?: string;
        grantedEquipment?: EquipmentInstance;
      }>('/pve/clear', {
        levelId,
        stars,
        ...(unitLevels ? { unitLevels } : {}),
        ...(stats ? { stats } : {}),
      });
    }

    /** Create a replay share link (S1-RP): 7-day TTL; anyone with the shareId can retrieve the replay (no login required). */
    async createReplayShare(roomId: string): Promise<{ shareId: string }> {
      return this.post<{ shareId: string }>(`/match/${roomId}/replay/share`, {});
    }

    /** Retrieve a replay via share link (S1-RP): no login required. */
    async getReplayByShare(shareId: string): Promise<{ replay: unknown }> {
      return this.request<{ replay: unknown }>('GET', `/share/replay/${shareId}`);
    }

    /**
     * Out-of-game sharing of a state-stream replay — mint a share code (REPLAY_SHARE_DESIGN §3.1): uploads the client-generated state-stream blob
     * and returns an unguessable shareCode. Login required. The blob is gzip+base64 compressed before upload (repetitive delta JSON compresses extremely well, §7);
     * the server stores it opaquely. Size exceeded / rate limited → ApiError('BAD_REQUEST' / 'RATE_LIMITED').
     */
    async createStateReplayShare(blob: unknown): Promise<{ shareCode: string }> {
      const packed = await packReplayBlob(blob);
      return this.post<{ shareCode: string }>('/replay/share', { blob: packed });
    }

    /** Public retrieval of a state-stream replay (REPLAY_SHARE_DESIGN §3.2): no login required; decompresses back to EncodedStateReplay after retrieval.
     *  Not found / expired → ApiError('NOT_FOUND'). */
    async getStateReplayShare(shareCode: string): Promise<{ blob: unknown }> {
      const { blob } = await this.request<{ blob: unknown }>('GET', `/r/${shareCode}`);
      return { blob: await unpackReplayBlob(blob) };
    }

    /** L1 replay sampling re-computation: submit the replay frames for a sampled level clear → headless third-party re-computation → materials are granted only if the computed stars meet or exceed the claimed value. */
    async pveVerify(
      verifyId: string,
      endFrame: number,
      frames: { frame: number; cmds: { side: number; commands: string }[] }[],
    ): Promise<{ save: SaveData; granted: Record<string, number>; capped: boolean; verified: boolean; grantedEquipment?: EquipmentInstance }> {
      return this.post<{
        save: SaveData;
        granted: Record<string, number>;
        capped: boolean;
        verified: boolean;
        grantedEquipment?: EquipmentInstance;
      }>('/pve/verify', { verifyId, endFrame, frames });
    }

    /**
     * @deprecated S3-2 per-stat upgrade. Since CC-1 unit progression is per-card via the Hero Roster (cardInv), not this endpoint.
     * PvE upgrade: server validates materials → deducts materials + increments pveUpgrades by 1 → pushes back. Insufficient materials → ApiError('INSUFFICIENT_FUNDS') (402).
     */
    async pveUpgrade(upgradeId: string): Promise<{ save: SaveData }> {
      return this.post<{ save: SaveData }>('/pve/upgrade', { upgradeId });
    }

    // ── Stamina system (A4) ──────────────────────────────────────────────────────────

    /** Replenish stamina (A4): costs 30 coins → grants +60 stamina (cap 120). Insufficient coins → 402. */
    async purchaseStamina(): Promise<{ stamina: { current: number; regenAt: number } }> {
      return this.post<{ stamina: { current: number; regenAt: number } }>('/pve/stamina/purchase', {
        amount: 60,
      });
    }

    /** PvE level entry (A4): deducts stamina the moment the player commits to a level (no refund on retreat/loss). Insufficient stamina → 402. */
    async pveEnter(levelId: string): Promise<{ stamina: { current: number; regenAt: number } }> {
      return this.post<{ stamina: { current: number; regenAt: number } }>('/pve/enter', { levelId });
    }

    /** Recent match history (ranked / friendly, reverse chronological order; requires login token). */
    async getMatchHistory(limit = 20): Promise<MatchHistoryEntry[]> {
      const data = await this.request<{ matches: MatchHistoryEntry[] }>(
        'GET',
        `/match/history?limit=${limit}`,
      );
      return data.matches;
    }

    /** Retrieve the server-side replay for a match (participants only; opaque frames, decoded for playback by net/serverReplay). 404 → ApiError. */
    async getMatchReplay(roomId: string): Promise<ServerReplay> {
      const data = await this.request<{ replay: ServerReplay }>(
        'GET',
        `/match/${encodeURIComponent(roomId)}/replay`,
      );
      return data.replay;
    }
  };
}
