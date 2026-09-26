// The rosters are validated here against the SAME rules socialsvc/worldsvc apply on create, because a
// roster entry the server rejects is not an error botsvc can recover from: that slot would fail to be
// founded forever and every bot waiting behind it would stay familyless.
import { describe, it, expect, vi } from 'vitest';
import { FAMILY_CAP, ORG_NAME_WIDTH_MAX, ORG_NAME_WIDTH_MIN, censorChat, orgNameWidth, type ChatRegion } from '@nw/shared';
import { BOT_FAMILY_ROSTER, BOT_SECT_ROSTER, BotOrgRegistry, PENDING_SEAT_TTL_MS, botFamilyId, botFamilySlot } from '../src/orgs';

const REGIONS: ChatRegion[] = ['global', 'cn', 'de', 'en'];

describe.each([
  ['family', BOT_FAMILY_ROSTER],
  ['sect', BOT_SECT_ROSTER],
])('%s roster', (_kind, roster) => {
  it('every TAG is unique and matches the server format ^[A-Z0-9]{2,5}$', () => {
    const tags = roster.map((e) => e.tag);
    expect(new Set(tags).size).toBe(tags.length);
    for (const t of tags) expect(t).toMatch(/^[A-Z0-9]{2,5}$/);
  });

  it('every name is within the org-name display width and passes the content filter', () => {
    for (const { name } of roster) {
      const w = orgNameWidth(name);
      expect(w, name).toBeGreaterThanOrEqual(ORG_NAME_WIDTH_MIN);
      expect(w, name).toBeLessThanOrEqual(ORG_NAME_WIDTH_MAX);
      for (const region of REGIONS) expect(censorChat(name, region).hit, `${name} (${region})`).toBe(false);
    }
  });
});

describe('BOT_FAMILY_ROSTER', () => {
  it('has enough seats for every bot account that exists (1700)', () => {
    expect(BOT_FAMILY_ROSTER.length * FAMILY_CAP).toBeGreaterThanOrEqual(1700);
  });

  it('names are unique too, so name+TAG identifies a slot', () => {
    expect(new Set(BOT_FAMILY_ROSTER.map((e) => e.name)).size).toBe(BOT_FAMILY_ROSTER.length);
  });

  it('botFamilySlot needs both name and TAG to match', () => {
    const e = BOT_FAMILY_ROSTER[5]!;
    expect(botFamilySlot(e)).toBe(5);
    expect(botFamilySlot({ name: 'Other', tag: e.tag })).toBe(-1);
    expect(botFamilyId(5)).toBe(`fam:${e.tag}`);
  });
});

describe('BotOrgRegistry', () => {
  it('pickSect ignores non-roster and full sects and prefers the emptiest', () => {
    const [a, b] = BOT_SECT_ROSTER;
    const row = (name: string, tag: string, n: number) => ({ sectId: tag, name, tag, leaderFamilyId: '', memberFamilyCount: n });
    expect(BotOrgRegistry.pickSect([row(a!.name, a!.tag, 5), row('Human', 'HUM', 0), row(b!.name, b!.tag, 2)])?.tag).toBe(b!.tag);
    expect(BotOrgRegistry.pickSect([row(a!.name, a!.tag, 30)])).toBeNull();
  });

  it('a create claim blocks other founders only until it expires', async () => {
    let now = 0;
    const orgs = new BotOrgRegistry(() => now);
    const social = { getFamily: async () => null } as any;
    expect(await orgs.pickFamily(social, 't')).toEqual({ kind: 'create', slot: 0 });
    expect(await orgs.pickFamily(social, 't')).toBeNull();
    now = 61_000; // claim (and the cached "not founded") both expired: the founder evidently failed
    expect(await orgs.pickFamily(social, 't')).toEqual({ kind: 'create', slot: 0 });
  });

  /** A bot family view for `slot` with `memberCount` members. */
  const botFam = (slot: number, memberCount: number) => {
    const { name, tag } = BOT_FAMILY_ROSTER[slot]!;
    return { familyId: botFamilyId(slot), name, tag, leaderId: 'l', memberCount, prosperity: 0 };
  };
  /** getFamily over a slot → memberCount map; slots not listed are "not founded yet". */
  const socialWith = (counts: Record<number, number>) => ({
    getFamily: vi.fn(async (_t: string, id: string) => {
      const slot = BOT_FAMILY_ROSTER.findIndex((_e, i) => botFamilyId(i) === id);
      return slot in counts ? botFam(slot, counts[slot]!) : null;
    }),
  });

  it('family lookups are served from cache for a minute, then fetched again', async () => {
    let now = 0;
    const orgs = new BotOrgRegistry(() => now);
    const social = socialWith({ 0: 3 });
    await orgs.pickFamily(social as any, 't');
    now = 59_000;
    await orgs.pickFamily(social as any, 't');
    expect(social.getFamily).toHaveBeenCalledTimes(1);
    now = 61_000;
    await orgs.pickFamily(social as any, 't');
    expect(social.getFamily).toHaveBeenCalledTimes(2);
  });

  it('a held pending seat frees up after PENDING_SEAT_TTL_MS, or at once on clearPending', async () => {
    let now = 0;
    const orgs = new BotOrgRegistry(() => now);
    const social = socialWith({ 0: FAMILY_CAP - 1, 1: 0 });
    orgs.notePending(0, 'bot-a');
    expect(await orgs.pickFamily(social as any, 't')).toMatchObject({ kind: 'join', slot: 1 });
    now = PENDING_SEAT_TTL_MS + 1;
    expect(await orgs.pickFamily(social as any, 't')).toMatchObject({ kind: 'join', slot: 0 });

    const fresh = new BotOrgRegistry(() => 0);
    fresh.notePending(0, 'bot-a');
    fresh.clearPending('bot-a');
    expect(await fresh.pickFamily(social as any, 't')).toMatchObject({ kind: 'join', slot: 0 });
  });

  it('a whole roster of full bot families yields nothing to do (no 65th family is invented)', async () => {
    const orgs = new BotOrgRegistry(() => 0);
    const social = socialWith(Object.fromEntries(BOT_FAMILY_ROSTER.map((_e, i) => [i, FAMILY_CAP])));
    expect(await orgs.pickFamily(social as any, 't')).toBeNull();
    expect(social.getFamily).toHaveBeenCalledTimes(BOT_FAMILY_ROSTER.length);
  });

  it('noteFamily after a successful create turns the slot into a join target for the next bot', async () => {
    const orgs = new BotOrgRegistry(() => 0);
    const social = socialWith({});
    expect(await orgs.pickFamily(social as any, 't')).toEqual({ kind: 'create', slot: 0 });
    orgs.noteFamily(0, botFam(0, 1));
    expect(await orgs.pickFamily(social as any, 't')).toEqual({ kind: 'join', slot: 0, familyId: botFamilyId(0) });
  });

  it('sect lists are cached per world until forgetSects', async () => {
    const orgs = new BotOrgRegistry(() => 0);
    const world = { listSects: vi.fn().mockResolvedValue([]) };
    await orgs.sectsIn(world as any, 't', 's1-0');
    await orgs.sectsIn(world as any, 't', 's1-0');
    await orgs.sectsIn(world as any, 't', 's1-1');
    expect(world.listSects).toHaveBeenCalledTimes(2);
    orgs.forgetSects('s1-0');
    await orgs.sectsIn(world as any, 't', 's1-0');
    expect(world.listSects).toHaveBeenCalledTimes(3);
  });
});
