// Bot-owned families and sects (BOTSVC_DESIGN §3.3).
//
// Bots only ever apply to families other bots founded, and a new bot family is founded only once every
// existing one is full. botsvc owns no database, so "which families are bot families" cannot be a
// stored list — it is a fixed roster instead: slot k of BOT_FAMILY_ROSTER is always the same name+TAG,
// the fleet fills the slots in order, and any process (including one just restarted) can rediscover
// the state by looking the slots up by id. The registry below is only a short-lived, process-wide cache
// over those lookups so that 100 familyless bots don't each re-walk the roster every minute.
import { FAMILY_CAP, SECT_FAMILY_CAP } from '@nw/shared';
import type { FamilyView, SocialClient } from './socialClient';
import type { SectView, WorldClient } from './worldClient';

export interface OrgName {
  name: string;
  tag: string;
}

/**
 * Two-letter prefixes are distinct within each list, so `adj[0..1] + noun[0..1]` is a unique 4-char TAG
 * by construction. Every combination is ≤ 12 display units (ORG_NAME_WIDTH_MAX).
 */
const FAMILY_ADJECTIVES = ['Red', 'Blue', 'Iron', 'Gold', 'Wild', 'Dark', 'Swift', 'Grey'];
const FAMILY_NOUNS = ['Quills', 'Inks', 'Pages', 'Crows', 'Wolves', 'Foxes', 'Owls', 'Ravens'];

/**
 * 64 slots × FAMILY_CAP 30 = 1920 seats, above the 1700 bot accounts that exist. Slot i pairs
 * adjective i%8 with noun (i%8 + ⌊i/8⌋)%8 — a bijection onto all 64 pairs that also keeps neighbouring
 * slots from sharing a word, so the first few families don't read as one naming series.
 */
export const BOT_FAMILY_ROSTER: readonly OrgName[] = Array.from({ length: 64 }, (_, i) => {
  const adj = FAMILY_ADJECTIVES[i % 8]!;
  const noun = FAMILY_NOUNS[(i % 8 + Math.floor(i / 8)) % 8]!;
  return { name: `${adj} ${noun}`, tag: `${adj.slice(0, 2)}${noun.slice(0, 2)}`.toUpperCase() };
});

/** Founded by the leaders of family slots 0..2 respectively; every other bot family joins one of these. */
export const BOT_SECT_ROSTER: readonly OrgName[] = [
  { name: 'Ink Pact', tag: 'INKP' },
  { name: 'Paper Crown', tag: 'PAPER' },
  { name: 'Lead Legion', tag: 'LEAD' },
];

/** socialsvc's family id format (socialsvc/src/family/shared.ts makeFamilyId). */
export function botFamilyId(slot: number): string {
  return `fam:${BOT_FAMILY_ROSTER[slot]!.tag}`;
}

/**
 * Roster slot of a family, or -1 if it is not a bot family. Both name AND tag must match: a human who
 * happens to pick one of the roster TAGs must not have the fleet pile into their family.
 */
export function botFamilySlot(fam: Pick<FamilyView, 'name' | 'tag'>): number {
  return BOT_FAMILY_ROSTER.findIndex((e) => e.tag === fam.tag && e.name === fam.name);
}

export function botSectSlot(sect: Pick<SectView, 'name' | 'tag'>): number {
  return BOT_SECT_ROSTER.findIndex((e) => e.tag === sect.tag && e.name === sect.name);
}

export type FamilyPick = { kind: 'join'; slot: number; familyId: string } | { kind: 'create'; slot: number };

/** How long a looked-up family / sect list is trusted before it is fetched again. */
const ORG_CACHE_TTL_MS = 60_000;
/** A create claim older than this is assumed to have died with its request and may be retried. */
const CREATE_CLAIM_TTL_MS = 60_000;
/**
 * How long an application filed by this process is counted against a family's free seats. Matches the
 * applicant's own re-apply backoff (bot.ts PENDING_JOIN_RECHECK_MS): after that the bot re-checks for
 * itself, so holding the seat any longer would only hide space that has in fact opened up.
 */
export const PENDING_SEAT_TTL_MS = 10 * 60_000;

export class BotOrgRegistry {
  private readonly families = new Map<number, { view: FamilyView | null; at: number }>();
  private readonly createClaims = new Map<number, number>();
  /** slot → (deviceId → filedAt): applications this process filed that no one has decided yet. */
  private readonly pending = new Map<number, Map<string, number>>();
  private readonly sects = new Map<string, { list: SectView[]; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * First roster slot a familyless bot should act on: the first bot family with a free seat (join), or
   * — when every earlier slot is full — the first slot not founded yet (create). Null means "nothing to
   * do right now": another bot is already founding the next slot, or the whole roster is full.
   */
  async pickFamily(social: SocialClient, token: string): Promise<FamilyPick | null> {
    for (let slot = 0; slot < BOT_FAMILY_ROSTER.length; slot++) {
      const view = await this.family(social, token, slot);
      if (view === null) return this.claimCreate(slot) ? { kind: 'create', slot } : null;
      if (botFamilySlot(view) !== slot) continue; // a human holds this TAG — skip the slot
      if (view.memberCount + this.pendingCount(slot) < FAMILY_CAP) {
        return { kind: 'join', slot, familyId: view.familyId };
      }
    }
    return null;
  }

  noteFamily(slot: number, view: FamilyView | null): void {
    this.families.set(slot, { view, at: this.now() });
    if (view) this.createClaims.delete(slot);
  }

  /** Drop what we know about a slot (a join/create just contradicted the cache). */
  forgetFamily(slot: number): void {
    this.families.delete(slot);
    this.createClaims.delete(slot);
  }

  notePending(slot: number, deviceId: string): void {
    let m = this.pending.get(slot);
    if (!m) this.pending.set(slot, (m = new Map()));
    m.set(deviceId, this.now());
  }

  /** The bot is now in a family (or gave up on the application): stop holding a seat for it anywhere. */
  clearPending(deviceId: string): void {
    for (const m of this.pending.values()) m.delete(deviceId);
  }

  async sectsIn(world: WorldClient, token: string, worldId: string): Promise<SectView[]> {
    const hit = this.sects.get(worldId);
    if (hit && this.now() - hit.at < ORG_CACHE_TTL_MS) return hit.list;
    const list = await world.listSects(token, worldId);
    this.sects.set(worldId, { list, at: this.now() });
    return list;
  }

  forgetSects(worldId: string): void {
    this.sects.delete(worldId);
  }

  /** Least-populated bot sect that still has room — spreads bot families across the three factions. */
  static pickSect(list: SectView[]): SectView | null {
    let best: SectView | null = null;
    for (const s of list) {
      if (botSectSlot(s) < 0 || s.memberFamilyCount >= SECT_FAMILY_CAP) continue;
      if (!best || s.memberFamilyCount < best.memberFamilyCount) best = s;
    }
    return best;
  }

  private async family(social: SocialClient, token: string, slot: number): Promise<FamilyView | null> {
    const hit = this.families.get(slot);
    if (hit && this.now() - hit.at < ORG_CACHE_TTL_MS) return hit.view;
    const view = await social.getFamily(token, botFamilyId(slot));
    this.noteFamily(slot, view);
    return view;
  }

  private claimCreate(slot: number): boolean {
    const at = this.createClaims.get(slot);
    if (at !== undefined && this.now() - at < CREATE_CLAIM_TTL_MS) return false;
    this.createClaims.set(slot, this.now());
    return true;
  }

  private pendingCount(slot: number): number {
    const m = this.pending.get(slot);
    if (!m) return 0;
    const cutoff = this.now() - PENDING_SEAT_TTL_MS;
    for (const [id, at] of m) if (at < cutoff) m.delete(id);
    return m.size;
  }
}
