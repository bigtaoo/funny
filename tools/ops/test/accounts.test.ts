// src/logic/accounts.ts — ops account creation and the per-row status/disable controls.
import { describe, expect, it } from 'vitest';
import {
  accountStatus, ADMIN_ROLES, createAccountInput, isSelf, resetPasswordPrompt, toggleButton,
} from '../src/logic/accounts';
import type { AdminAccountView, Session } from '../src/types';

const account = (over: Partial<AdminAccountView> = {}): AdminAccountView => ({
  id: 'a-1', username: 'ada', role: 'ops', displayName: 'Ada', disabled: false, createdAt: 0, ...over,
});
const session = (id: string): Session => ({ token: 't', admin: account({ id }), capabilities: [] });

describe('ADMIN_ROLES', () => {
  it('lists the four roles least-privileged first', () => {
    expect(ADMIN_ROLES).toEqual(['viewer', 'support', 'ops', 'super']);
  });
});

describe('createAccountInput', () => {
  it('trims the username and display name', () => {
    expect(createAccountInput({ username: ' ada ', password: 'pw', displayName: ' Ada L ', role: 'ops' }))
      .toEqual({ username: 'ada', password: 'pw', role: 'ops', displayName: 'Ada L' });
  });

  it('falls back to the username when no display name was given, so the column is never blank', () => {
    expect(createAccountInput({ username: ' ada ', password: 'pw', displayName: '   ', role: 'viewer' }))
      .toMatchObject({ username: 'ada', displayName: 'ada' });
  });

  it('leaves the password untouched — trimming it would silently change the credential', () => {
    expect(createAccountInput({ username: 'ada', password: '  pw  ', displayName: 'A', role: 'ops' }).password).toBe('  pw  ');
  });
});

describe('accountStatus', () => {
  it('shows an active account in the green pill class', () => {
    expect(accountStatus({ disabled: false })).toEqual({ label: 'active', cls: 'executed' });
  });

  it('shows a disabled account in the red one', () => {
    expect(accountStatus({ disabled: true })).toEqual({ label: 'disabled', cls: 'failed' });
  });
});

describe('isSelf', () => {
  it('recognises the logged-in operator’s own row', () => {
    expect(isSelf(account({ id: 'a-1' }), session('a-1'))).toBe(true);
  });

  it('does not match a different account', () => {
    expect(isSelf(account({ id: 'a-2' }), session('a-1'))).toBe(false);
  });
});

describe('toggleButton', () => {
  it('offers to disable an active account', () => {
    expect(toggleButton({ disabled: false })).toEqual({ label: 'Disable', cls: 'danger', nextDisabled: true });
  });

  it('offers to enable a disabled one, in the quieter style', () => {
    expect(toggleButton({ disabled: true })).toEqual({ label: 'Enable', cls: 'ghost', nextDisabled: false });
  });

  it('always asks for the OPPOSITE of the current state', () => {
    for (const disabled of [true, false]) {
      expect(toggleButton({ disabled }).nextDisabled).toBe(!disabled);
    }
  });
});

describe('resetPasswordPrompt', () => {
  it('names the account and repeats the length rule', () => {
    expect(resetPasswordPrompt('ada')).toBe('Set new password for ada (≥6)');
  });
});
