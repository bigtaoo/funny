// Ladder season ops (SE-3) + anti-cheat mismatch/suspicious-PvE views + manual ban (C3/C4/S4-4).
import type { LadderSeasonInfo, MismatchRow, PvpCardStatRow, SuspiciousPveRow } from '../clients';
import type { AdminBaseCtor, Constructor } from './base';

export interface LadderHandlers {
  getLadderCurrentSeason(): Promise<LadderSeasonInfo | null>;
  rollLadderSeason(actor: string): Promise<LadderSeasonInfo>;
  listMismatches(): Promise<MismatchRow[]>;
  listPvpCardStats(filter: { mode?: string; since?: string }): Promise<PvpCardStatRow[]>;
  listSuspiciousPve(): Promise<SuspiciousPveRow[]>;
  banAccount(accountId: string): Promise<{ ok: boolean }>;
  unbanAccount(accountId: string): Promise<{ ok: boolean }>;
}

export function LadderMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<LadderHandlers> {
  return class extends Base {
    // ───────────────────── Ladder season ops (SE-3) ──────────────────────────
    /** Get current ladder season summary; returns null if meta is unreachable (ops frontend uses this to highlight approaching endAt). */
    async getLadderCurrentSeason(): Promise<LadderSeasonInfo | null> {
      if (!this.ladder.available) return null;
      return this.ladder.getCurrentSeason();
    }

    /** CAS-idempotent advance of the ladder season (open a new season). Audited. */
    async rollLadderSeason(actor: string): Promise<LadderSeasonInfo> {
      const season = await this.ladder.rollSeason();
      await this.audit(actor, 'ladder.season.roll', { summary: `→ s${season.seasonNo}` });
      return season;
    }

    /** List of matches with hash mismatches within the last 24 h (C3, anticheat.view capability). */
    async listMismatches(): Promise<MismatchRow[]> {
      if (!this.mismatches.available) return [];
      return this.mismatches.listMismatches();
    }

    /** BALANCE data pipeline (P1): deck-composition win-rate by card, optionally filtered by mode/since (analytics.view capability). */
    async listPvpCardStats(filter: { mode?: string; since?: string }): Promise<PvpCardStatRow[]> {
      if (!this.pvpCardStats.available) return [];
      return this.pvpCardStats.listPvpCardStats(filter);
    }

    /** C4: list of suspicious accounts with pveWarnings > 0 (anticheat.view capability). */
    async listSuspiciousPve(): Promise<SuspiciousPveRow[]> {
      if (!this.suspiciousPve.available) return [];
      return this.suspiciousPve.listSuspiciousPve();
    }

    /** S4-4: manual account ban (anticheat.action capability). */
    async banAccount(accountId: string): Promise<{ ok: boolean }> {
      if (!this.suspiciousPve.available) return { ok: false };
      return this.suspiciousPve.banAccount(accountId);
    }

    /** S4-4: manual account unban (anticheat.action capability). */
    async unbanAccount(accountId: string): Promise<{ ok: boolean }> {
      if (!this.suspiciousPve.available) return { ok: false };
      return this.suspiciousPve.unbanAccount(accountId);
    }
  };
}
