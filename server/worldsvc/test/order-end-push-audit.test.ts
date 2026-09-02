// Guard for the class of bug behind the 2026-09-02 report ("五支队伍都在野外停留，占领却说尚无队伍").
//
// The rule: the world map re-reads its marches / occupations / stationed slices ONLY when a
// `march_update` push arrives (client worldmap/net/push.ts applyMarchUpdate → refreshMarches). The 5s
// poll that used to cover everything else was deleted in comm-audit-2026-07-27 P1-2 on the assumption
// that push covers every state change, and `tile_update` refreshes tiles alone. So **a server path that
// ends a field order must announce it on the march_update channel** — otherwise the client keeps the
// dead order forever, and every team it names is busy for the rest of the session, which the team
// picker turns into a flat refusal to dispatch. Nothing recovers it short of a page reload.
//
// settleOccupation was the reported instance. Auditing every sibling deletion site turned up three more
// that were live and reachable (expulsion, encounter-kills-a-stationed-team, abandonTile) plus one
// dormant (cancelOccupation, no client caller yet). Each is pinned behaviourally in its own suite —
// here and in combatSiege-occupation-encounter-gaps.test.ts — but behavioural tests only cover the
// paths someone thought to write, and the whole point is that nobody thought of these four. So this
// file ALSO scans the source for order-ending deletions and fails on any site not in the reviewed
// table below. A new deletion site is then a deliberate decision ("how does the owner find out?")
// instead of a silent regression.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src');

/** Deleting one of these ends a field order that has NO MarchDoc left to report it. */
const DELETION_RE = /cols\.(occupations|stationed)\.(deleteOne|findOneAndDelete)\b/g;

/**
 * Reviewed order-ending deletion sites: file → how many, and how the owner is told.
 * `pushes` is the number of those sites that must reach `pushOrderEnded`; the remainder are sites that
 * hand the order straight to something else which pushes on its own (a fresh march, a return leg).
 */
const REVIEWED: Record<string, { sites: number; pushes: number; why: string }> = {
  'combatSiege/occupation.ts': {
    sites: 3,
    pushes: 3,
    why: 'settleOccupation (hold completes), applyOccupationExpulsion (tells the EXPELLED holder), cancelOccupation',
  },
  'combatSiege/encounter.ts': {
    sites: 1,
    pushes: 1,
    why: 'a field encounter destroys a resident stationed team — mirrors the defMarch branch beside it, which already pushed',
  },
  'combatMarch/stationed.ts': {
    sites: 1,
    pushes: 0,
    why: 'recallStationed hands the team to a return march, and startReturnMarch pushes that march itself',
  },
  'combatMarch/command.ts': {
    sites: 1,
    pushes: 0,
    why: 'ADR-051 P3c idle-redispatch claims the station and immediately dispatches a new march, which pushes',
  },
  'territory.ts': {
    sites: 1,
    pushes: 1,
    why: 'abandonTile frees the team parked on the surrendered tile; doAbandon never re-reads ctx.stationed',
  },
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

function scan(): Map<string, { sites: number; pushes: number }> {
  const found = new Map<string, { sites: number; pushes: number }>();
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8');
    const sites = (src.match(DELETION_RE) ?? []).length;
    if (sites === 0) continue;
    const rel = file.slice(SRC.length + 1).split('\\').join('/');
    found.set(rel, { sites, pushes: (src.match(/pushOrderEnded\(/g) ?? []).length });
  }
  return found;
}

describe('order-ending deletions must announce themselves on the march_update channel', () => {
  const found = scan();

  it('every file that deletes an OccupationDoc/StationedDoc has been reviewed against the rule', () => {
    // A failure here is not "add your file to the list" — it is "decide how the owner's client learns
    // this order ended", then record the answer. Silence is what shipped the reported bug.
    expect([...found.keys()].sort()).toEqual(Object.keys(REVIEWED).sort());
  });

  for (const [file, expected] of Object.entries(REVIEWED)) {
    it(`${file}: ${expected.sites} deletion site(s), ${expected.pushes} announced directly — ${expected.why}`, () => {
      expect(found.get(file)).toEqual({ sites: expected.sites, pushes: expected.pushes });
    });
  }

  it('the client really does hang its only order refresh off march_update (the premise of all of the above)', () => {
    // If this ever stops being true — a poll comes back, or tile_update starts refreshing orders too —
    // the rule above is over-strict and this whole file should be revisited rather than worked around.
    const push = readFileSync(
      join(__dirname, '..', '..', '..', 'client', 'src', 'scenes', 'worldmap', 'net', 'push.ts'),
      'utf8',
    );
    const applyMarch = push.slice(push.indexOf('export function applyMarchUpdate'), push.indexOf('export function applyNationMsg'));
    expect(applyMarch).toContain('refreshMarches(ctx)');
    const applyTile = push.slice(push.indexOf('export function applyTileUpdate'), push.indexOf('export function applyUnderAttack'));
    expect(applyTile).not.toContain('refreshMarches');
  });
});
