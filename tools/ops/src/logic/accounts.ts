// Pure layer for the ops account management page (ADR-070 Phase 4e).
import type { AdminAccountView, Session } from '../types';

/** Assignable roles, least to most privileged — the order both `<select>`s render. */
export const ADMIN_ROLES = ['viewer', 'support', 'ops', 'super'];

/**
 * The create-account payload. Display name falls back to the username so the account list never has
 * a blank column; the server validates lengths (username ≥3, password ≥6) authoritatively.
 */
export function createAccountInput(fields: {
  username: string;
  password: string;
  displayName: string;
  role: string;
}): { username: string; password: string; role: string; displayName: string } {
  const username = fields.username.trim();
  return {
    username,
    password: fields.password,
    role: fields.role,
    displayName: fields.displayName.trim() || username,
  };
}

/** The status pill. `executed` is the shared green class name, inherited from the ticket pills. */
export function accountStatus(a: Pick<AdminAccountView, 'disabled'>): { label: string; cls: string } {
  return a.disabled ? { label: 'disabled', cls: 'failed' } : { label: 'active', cls: 'executed' };
}

/**
 * Whether this row is the logged-in operator, which is what disables its own Disable button — a
 * self-lockout would need another super-admin to undo. Not a security boundary (the backend refuses
 * it too); this only keeps the UI from offering it.
 */
export function isSelf(a: Pick<AdminAccountView, 'id'>, session: Session): boolean {
  return a.id === session.admin.id;
}

/** The enable/disable button, whose label, class and meaning all flip together. */
export function toggleButton(a: Pick<AdminAccountView, 'disabled'>): { label: string; cls: string; nextDisabled: boolean } {
  return a.disabled
    ? { label: 'Enable', cls: 'ghost', nextDisabled: false }
    : { label: 'Disable', cls: 'danger', nextDisabled: true };
}

export function resetPasswordPrompt(username: string): string {
  return `Set new password for ${username} (≥6)`;
}
