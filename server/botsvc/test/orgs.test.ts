// The rosters are validated here against the SAME rules socialsvc/worldsvc apply on create, because a
// roster entry the server rejects is not an error botsvc can recover from: that slot would fail to be
// founded forever and every bot waiting behind it would stay familyless.
import { describe, it, expect } from 'vitest';
import { FAMILY_CAP, ORG_NAME_WIDTH_MAX, ORG_NAME_WIDTH_MIN, censorChat, orgNameWidth, type ChatRegion } from '@nw/shared';
import { BOT_FAMILY_ROSTER, BOT_SECT_ROSTER, BotOrgRegistry, botFamilyId, botFamilySlot } from '../src/orgs';

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
});
