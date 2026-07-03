// Unit tests for admin.ts: RBAC role→capability matrix, compensation quota tiering, approval-capability routing
// (OPS_DESIGN.md §2.2/§3.2). Pure functions, no DB. Security-sensitive: guards against privilege drift.
import { describe, it, expect } from 'vitest';
import {
  ADMIN_ROLES,
  isAdminRole,
  ROLE_CAPABILITIES,
  capabilitiesForRole,
  roleHasCapability,
  SINGLE_COMP_QUOTA,
  ITEM_COIN_EQUIV,
  SKIN_COIN_EQUIV,
  attachmentCoinValue,
  totalCoinValue,
  tierForAttachments,
  requiredApproveCapability,
  requiredInitiateCapability,
  type AdminRole,
  type AdminCapability,
  type CompAttachment,
} from '../src/admin';

// ── roles ─────────────────────────────────────────────────────────────────────────

describe('roles', () => {
  it('isAdminRole guards the union', () => {
    for (const r of ADMIN_ROLES) expect(isAdminRole(r)).toBe(true);
    expect(isAdminRole('root')).toBe(false);
    expect(isAdminRole(123)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });
});

// ── RBAC matrix ───────────────────────────────────────────────────────────────────

describe('ROLE_CAPABILITIES', () => {
  it('super has every capability that any role has (superset)', () => {
    const allCaps = new Set<AdminCapability>();
    for (const role of ADMIN_ROLES) for (const c of ROLE_CAPABILITIES[role]) allCaps.add(c);
    for (const c of allCaps) expect(roleHasCapability('super', c)).toBe(true);
  });

  it('no role has duplicate capabilities', () => {
    for (const role of ADMIN_ROLES) {
      const caps = ROLE_CAPABILITIES[role];
      expect(new Set(caps).size).toBe(caps.length);
    }
  });

  it('lower roles are a strict subset of super (no capability outside super)', () => {
    const superSet = new Set(ROLE_CAPABILITIES.super);
    for (const role of ADMIN_ROLES) {
      for (const c of ROLE_CAPABILITIES[role]) expect(superSet.has(c)).toBe(true);
    }
  });

  it('only super can manage admin accounts (no privilege escalation)', () => {
    expect(roleHasCapability('super', 'admin.manage')).toBe(true);
    for (const role of ['ops', 'support', 'viewer'] as AdminRole[]) {
      expect(roleHasCapability(role, 'admin.manage')).toBe(false);
    }
  });

  it('only super can approve over-quota / global compensation', () => {
    for (const cap of ['comp.approve.single.overquota', 'comp.approve.global'] as AdminCapability[]) {
      expect(roleHasCapability('super', cap)).toBe(true);
      for (const role of ['ops', 'support', 'viewer'] as AdminRole[]) {
        expect(roleHasCapability(role, cap)).toBe(false);
      }
    }
  });

  it('viewer is read-only (no *.action / *.manage / *.approve / *.initiate)', () => {
    for (const c of ROLE_CAPABILITIES.viewer) {
      expect(c).not.toMatch(/\.(action|manage|approve|initiate)/);
    }
  });

  it('capabilitiesForRole returns a copy (mutating it does not affect the source)', () => {
    const caps = capabilitiesForRole('ops');
    caps.push('admin.manage');
    expect(roleHasCapability('ops', 'admin.manage')).toBe(false);
  });
});

// ── attachment valuation ──────────────────────────────────────────────────────────

describe('attachmentCoinValue', () => {
  it('coins are worth their face amount', () => {
    expect(attachmentCoinValue({ kind: 'coins', count: 300 })).toBe(300);
  });

  it('items and skins use their coin-equivalent, defaulting count to 1', () => {
    expect(attachmentCoinValue({ kind: 'item' })).toBe(ITEM_COIN_EQUIV);
    expect(attachmentCoinValue({ kind: 'skin' })).toBe(SKIN_COIN_EQUIV);
    expect(attachmentCoinValue({ kind: 'item', count: 3 })).toBe(ITEM_COIN_EQUIV * 3);
  });

  it('coins with no count are worth 0', () => {
    expect(attachmentCoinValue({ kind: 'coins' })).toBe(0);
  });

  it('negative counts are clamped to 0', () => {
    expect(attachmentCoinValue({ kind: 'item', count: -5 })).toBe(0);
  });
});

describe('totalCoinValue', () => {
  it('sums every attachment', () => {
    const atts: CompAttachment[] = [
      { kind: 'coins', count: 1000 },
      { kind: 'item', count: 2 }, // 1000
      { kind: 'skin' }, // 2000
    ];
    expect(totalCoinValue(atts)).toBe(1000 + ITEM_COIN_EQUIV * 2 + SKIN_COIN_EQUIV);
  });

  it('is 0 for no attachments', () => {
    expect(totalCoinValue([])).toBe(0);
  });
});

// ── quota tiering ─────────────────────────────────────────────────────────────────

describe('tierForAttachments', () => {
  it('at or below quota is normal', () => {
    expect(tierForAttachments([{ kind: 'coins', count: SINGLE_COMP_QUOTA }])).toBe('normal');
  });

  it('above quota is overquota', () => {
    expect(tierForAttachments([{ kind: 'coins', count: SINGLE_COMP_QUOTA + 1 }])).toBe('overquota');
  });
});

// ── approval / initiate routing ───────────────────────────────────────────────────

describe('requiredApproveCapability', () => {
  it('single normal → comp.approve.single', () => {
    expect(requiredApproveCapability('single', 'normal')).toBe('comp.approve.single');
  });

  it('single overquota → super-only capability', () => {
    expect(requiredApproveCapability('single', 'overquota')).toBe('comp.approve.single.overquota');
  });

  it('global → super-only capability regardless of tier', () => {
    expect(requiredApproveCapability('global', 'normal')).toBe('comp.approve.global');
    expect(requiredApproveCapability('global', 'overquota')).toBe('comp.approve.global');
  });

  it('the routed approval capability is actually held by super', () => {
    for (const scope of ['single', 'global'] as const) {
      for (const tier of ['normal', 'overquota'] as const) {
        expect(roleHasCapability('super', requiredApproveCapability(scope, tier))).toBe(true);
      }
    }
  });
});

describe('requiredInitiateCapability', () => {
  it('routes by scope', () => {
    expect(requiredInitiateCapability('single')).toBe('comp.initiate.single');
    expect(requiredInitiateCapability('global')).toBe('comp.initiate.global');
  });
});
