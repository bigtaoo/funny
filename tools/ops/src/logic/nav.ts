// Pure layer for the shell's navigation (ADR-070 Phase 4e).
//
// The nav is a list of (id, label, required capability) triples plus one filter. Keeping the triples
// here — and the `id → page renderer` binding in app.ts — is what lets the capability filter be tested
// without constructing the shell: app.ts's own imports pull in every page module, and through them the
// whole DOM half of the console.
//
// NOT a security boundary. Real authorization is enforced at each backend endpoint; the frontend uses
// capabilities only to decide what to render (see the header of src/types.ts).
import type { AdminCapability } from '../types';

export interface NavEntry {
  id: string;
  label: string;
  cap: AdminCapability;
}

/** Sidebar order. The first entry a session can see is the page it lands on. */
export const NAV_ENTRIES: readonly NavEntry[] = [
  { id: 'monitor', label: 'Monitor', cap: 'monitor.view' },
  { id: 'analytics', label: 'Analytics', cap: 'analytics.view' },
  { id: 'pvp-balance', label: 'PvP Balance', cap: 'analytics.view' },
  { id: 'player', label: 'Player Lookup', cap: 'player.lookup' },
  { id: 'suspicions', label: 'Anti-Cheat', cap: 'anticheat.view' },
  { id: 'reports', label: 'UGC Reports', cap: 'reports.view' },
  { id: 'appeals', label: 'Player Appeals', cap: 'appeals.view' },
  { id: 'feedback', label: 'Player Feedback', cap: 'feedback.view' },
  { id: 'tickets', label: 'Comp Tickets', cap: 'comp.view' },
  { id: 'audit', label: 'Audit', cap: 'audit.view.self' },
  { id: 'paddle-events', label: 'Paddle Events', cap: 'paddle.events.view' },
  { id: 'slg-season', label: 'SLG Season', cap: 'slg.season.view' },
  { id: 'slg-audit', label: 'SLG Audit', cap: 'slg.audit.view' },
  { id: 'ladder', label: 'Ladder Season', cap: 'ladder.season.manage' },
  { id: 'events', label: 'Timed Events', cap: 'events.manage' },
  { id: 'gacha-pools', label: 'Gacha Pools', cap: 'gacha.pools.manage' },
  { id: 'promo', label: 'Promo Codes', cap: 'promo.manage' },
  { id: 'slg-shop', label: 'SLG Shop Prices', cap: 'slg.shop.manage' },
  { id: 'flags', label: 'Feature Flags', cap: 'config.manage' },
  { id: 'moderation-wordlist', label: 'Word Lists', cap: 'moderation.wordlist.manage' },
  { id: 'accounts', label: 'Account Mgmt', cap: 'admin.manage' },
];

/** The entries this session may see, in NAV_ENTRIES order. */
export function visibleNav(capabilities: readonly AdminCapability[]): NavEntry[] {
  return NAV_ENTRIES.filter((n) => capabilities.includes(n.cap));
}

/** Shown instead of a page when a session's capability set matches no nav entry at all. */
export const NO_CAPABILITIES_MESSAGE = 'This account has no visible capabilities. Contact a super-admin.';

export function whoText(admin: { displayName: string; role: string }): string {
  return `${admin.displayName} · ${admin.role}`;
}

export function buildTitle(buildTime: string): string {
  return `Built at ${buildTime} (UTC)`;
}

export function buildLabel(version: string): string {
  return `v ${version}`;
}

/** Login-page messages the shell shows after a session ends, kept next to the nav they replace. */
export const SESSION_EXPIRED_MESSAGE = 'Session expired. Please log in again.';
export const LOGGED_OUT_MESSAGE = 'Logged out.';
