// src/logic/nav.ts — the shell's navigation table and its capability filter.
//
// Worth testing at all because a capability typo in that table is invisible: the entry simply never
// appears, for everyone, and nobody notices until an operator says a page is missing. The last test
// here is the one that catches that class of mistake — it cross-checks every `cap` against the
// AdminCapability union as spelled in src/types.ts.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLabel, buildTitle, NAV_ENTRIES, visibleNav, whoText } from '../src/logic/nav';
import type { AdminCapability } from '../src/types';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('visibleNav', () => {
  it('shows nothing for a session with no capabilities', () => {
    expect(visibleNav([])).toEqual([]);
  });

  it('shows only the entries whose capability the session holds', () => {
    expect(visibleNav(['player.lookup']).map((n) => n.id)).toEqual(['player']);
  });

  it('keeps NAV_ENTRIES order regardless of the order capabilities were granted in', () => {
    // The first visible entry is the page the shell lands on, so this order is user-visible.
    const caps: AdminCapability[] = ['admin.manage', 'monitor.view', 'promo.manage'];
    expect(visibleNav(caps).map((n) => n.id)).toEqual(['monitor', 'promo', 'accounts']);
    expect(visibleNav([...caps].reverse()).map((n) => n.id)).toEqual(['monitor', 'promo', 'accounts']);
  });

  it('shows both pages that share analytics.view', () => {
    expect(visibleNav(['analytics.view']).map((n) => n.id)).toEqual(['analytics', 'pvp-balance']);
  });

  it('shows everything to a session holding every listed capability', () => {
    const all = [...new Set(NAV_ENTRIES.map((n) => n.cap))];
    expect(visibleNav(all)).toHaveLength(NAV_ENTRIES.length);
  });

  it('returns a fresh array — the shell filters it again before rendering', () => {
    const out = visibleNav(['monitor.view']);
    out.pop();
    expect(visibleNav(['monitor.view'])).toHaveLength(1);
  });
});

describe('NAV_ENTRIES', () => {
  it('has unique ids (the id keys the renderer map and the active-tab marker)', () => {
    const ids = NAV_ENTRIES.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a non-empty label for every entry', () => {
    expect(NAV_ENTRIES.filter((n) => !n.label.trim())).toEqual([]);
  });

  it('names only capabilities the AdminCapability union declares', () => {
    // TypeScript already rejects an unknown literal here, but the union is a mirror of
    // server/shared/admin.ts maintained by hand — this reads the union out of the source so a
    // capability that was renamed on the server (and dutifully renamed in types.ts) cannot leave a
    // nav entry pointing at a string no session will ever hold.
    const src = readFileSync(join(PKG, 'src', 'types.ts'), 'utf8');
    const union = src.slice(src.indexOf('export type AdminCapability'));
    const declared = new Set([...union.slice(0, union.indexOf(';')).matchAll(/'([^']+)'/g)].map((m) => m[1]!));
    expect(declared.size).toBeGreaterThan(20);
    expect(NAV_ENTRIES.filter((n) => !declared.has(n.cap)).map((n) => n.id)).toEqual([]);
  });
});

describe('header strings', () => {
  it('names the operator and their role', () => {
    expect(whoText({ displayName: 'Ada', role: 'super' })).toBe('Ada · super');
  });

  it('labels the build and explains the timestamp in its tooltip', () => {
    expect(buildLabel('abc1234')).toBe('v abc1234');
    expect(buildTitle('2026-08-20 09:15')).toBe('Built at 2026-08-20 09:15 (UTC)');
  });
});
