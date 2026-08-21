// Pure layer for the SLG season management page (G7/§17.7; ADR-070 Phase 4e).
//
// The load-bearing part is `worldActions`: which lifecycle transitions a world offers is a small state
// machine (open → settle → reset → re-open or close) that the backend also enforces, and it used to be
// an `if/else if` inside a row builder. Having it here means the confirm wording travels with the
// action it guards — the "Close" prompt in particular was written out twice, once per branch.
import type { SlgAllocateResult, SlgWorldSummary } from '../types';

const SLG_WORLD_STATUS_CLS: Record<string, string> = {
  open: 'ok',
  settling: 'warn',
  resetting: 'warn',
  closed: '',
};

/** Unknown statuses fall back to the neutral blue pill rather than rendering unstyled. */
export function worldStatusCls(status: string): string {
  return SLG_WORLD_STATUS_CLS[status] ?? 'info';
}

export interface WorldAction {
  id: 'settle' | 'close' | 'reset' | 'merge';
  label: string;
  cls: string;
  /**
   * The prompt to confirm with, or null for `merge`, which asks for a target shard first (see
   * mergeConfirm).
   *
   * Named `confirmText` rather than `confirm` on purpose: test/pureLayerBoundary.test.ts forbids the
   * identifier `confirm` anywhere in src/logic/** by name, and it cannot tell a property key from a
   * call to the browser's `confirm()`. Blunt by design — a rule that has to parse the file to be
   * right is a rule that will be wrong quietly — so the pure layer pays for it with a longer name.
   */
  confirmText: string | null;
}

/**
 * The transitions legal for this world, in button order. `active` is accepted alongside `open` because
 * worldsvc has used both spellings for a running world. A closed world (or any unrecognised status)
 * offers nothing — there is no transition out of closed, and inventing one here would only produce a
 * backend rejection.
 */
export function worldActions(w: Pick<SlgWorldSummary, 'worldId' | 'status'>, canManage: boolean): WorldAction[] {
  if (!canManage) return [];
  const close: WorldAction = {
    id: 'close', label: 'Close', cls: 'ghost',
    confirmText: `Archive world "${w.worldId}"? This permanently closes it.`,
  };
  if (w.status === 'open' || w.status === 'active') {
    return [
      {
        id: 'settle', label: 'Settle', cls: 'warn',
        confirmText: `Settle world "${w.worldId}"? This distributes rewards and marks the season as settling.`,
      },
      close,
      { id: 'merge', label: 'Merge into…', cls: 'danger', confirmText: null },
    ];
  }
  if (w.status === 'settling' || w.status === 'resetting') {
    return [
      {
        id: 'reset', label: 'Reset', cls: 'danger',
        confirmText: `DANGER: Reset world "${w.worldId}"? This wipes all world data and re-opens it. Irreversible.`,
      },
      close,
    ];
  }
  return [];
}

export function seasonShardText(w: Pick<SlgWorldSummary, 'season' | 'shard'>): string {
  return `S${w.season} · shard ${w.shard}`;
}

export function populationText(w: Pick<SlgWorldSummary, 'population' | 'capacity'>): string {
  return `${w.population.toLocaleString()} / ${w.capacity.toLocaleString()}`;
}

// ── Allocate next season (the correct way to start one) ──

/** Spells out that this MOVES every account — reopening a world via openConfirm does not. */
export function allocateConfirm(season: number, capacity: string): string {
  return `Allocate season ${season} (capacity ${capacity} per shard)? This settles shard balancing from the previous season's results and opens fresh worlds — every account will be routed to the new map on next login.`;
}

export function allocateOkText(season: number, r: SlgAllocateResult): string {
  return `Season ${season} allocated: ${r.shardCount} shard(s) — ${r.worldIds.join(', ')} (${r.allocatedFamilies} families placed)`;
}

// ── Open a single world (low-level escape hatch) ──

export function openConfirm(worldId: string, season: string, shard: string, capacity: string): string {
  return `Open world "${worldId}" season ${season} shard ${shard} cap ${capacity}?`;
}

// ── G6 shard merge (§27) ──

export function mergePrompt(w: Pick<SlgWorldSummary, 'worldId' | 'season'>): string {
  return `Merge "${w.worldId}" into which shard? (worldId, e.g. s${w.season}-0)`;
}

export function mergeConfirm(worldId: string, targetWorldId: string): string {
  return `DANGER: Move every remaining player out of "${worldId}" into "${targetWorldId}", then permanently close "${worldId}"? Irreversible — use only for a low-population shard (§27).`;
}

/**
 * Partial failure is normal here (a player mid-march cannot be moved), so the count is reported either
 * way. Keeps the literal "player(s)" of the original rather than reaching for `plural`: this is a
 * behaviour-preserving extraction, and quietly improving a string is still changing it.
 */
export function mergeOkText(r: { moved: number; failed: string[] }): string {
  return `Moved ${r.moved} player(s)${r.failed.length ? `, ${r.failed.length} failed (see server logs)` : ''}`;
}
