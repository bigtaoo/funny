// src/logic/player.ts — player lookup: which id every admin action targets, the detail table, and
// the ban button's three coupled properties.
import { describe, expect, it } from 'vitest';
import {
  banButton, banConfirm, banMessage, detailLookup, playerDetailRows, playerStatus,
  resetPasswordConfirm, resultsText, summaryCells, targetAccountId,
} from '../src/logic/player';
import type { PlayerProfile, PlayerSummary } from '../src/types';

const row: PlayerSummary = { accountId: 'acc-row', publicId: '123456789', displayName: 'Ada', loginId: 'ada@example.com' };
const profile: PlayerProfile = { publicId: '123456789' };

describe('targetAccountId', () => {
  it('prefers the profile’s own accountId', () => {
    expect(targetAccountId({ accountId: 'acc-profile' }, row)).toBe('acc-profile');
  });

  it('falls back to the search row when a publicId lookup omitted it', () => {
    expect(targetAccountId({}, row)).toBe('acc-row');
  });
});

describe('detailLookup', () => {
  it('fetches by publicId when the row has one', () => {
    expect(detailLookup(row)).toEqual({ by: 'publicId', publicId: '123456789' });
  });

  it('falls back to accountId for a row that predates public ids', () => {
    expect(detailLookup({ accountId: 'acc-row' })).toEqual({ by: 'accountId', accountId: 'acc-row' });
  });
});

describe('playerDetailRows', () => {
  it('renders every optional field as an em dash when the profile is bare', () => {
    expect(playerDetailRows(profile, row)).toEqual([
      ['Public ID', '#123456789'],
      ['accountId', 'acc-row'],
      ['Display name', '—'],
      ['Rank', '—'],
      ['ELO', '—'],
      ['Wins / Losses', '—'],
    ]);
  });

  it('shows a full profile', () => {
    const full: PlayerProfile = { publicId: '9', accountId: 'acc-1', displayName: 'Ada', rank: 'Gold', elo: 1420, wins: 10, losses: 4 };
    expect(playerDetailRows(full, row)).toEqual([
      ['Public ID', '#9'],
      ['accountId', 'acc-1'],
      ['Display name', 'Ada'],
      ['Rank', 'Gold'],
      ['ELO', '1420'],
      ['Wins / Losses', '10 / 4'],
    ]);
  });

  it('keeps a zero ELO and zero losses instead of dashing them out', () => {
    const zeroes: PlayerProfile = { publicId: '9', elo: 0, wins: 0 };
    expect(playerDetailRows(zeroes, row)).toContainEqual(['ELO', '0']);
    expect(playerDetailRows(zeroes, row)).toContainEqual(['Wins / Losses', '0 / 0']);
  });
});

describe('playerStatus', () => {
  it('reads an unbanned or unknown ban state as active', () => {
    expect(playerStatus(false)).toEqual({ label: 'active', cls: 'ok' });
    expect(playerStatus(undefined)).toEqual({ label: 'active', cls: 'ok' });
  });

  it('reads a banned account as banned', () => {
    expect(playerStatus(true)).toEqual({ label: 'banned', cls: 'failed' });
  });
});

describe('banButton', () => {
  it('offers to ban an active player, in the destructive style', () => {
    expect(banButton(false)).toEqual({ label: 'Ban', cls: 'danger', willBan: true });
  });

  it('offers to unban a banned one, without the destructive style', () => {
    expect(banButton(true)).toEqual({ label: 'Unban', cls: '', willBan: false });
  });

  it('keeps label and action in step — the confirm text is built from the same flag', () => {
    for (const banned of [true, false]) {
      const b = banButton(banned);
      expect(banConfirm(b.willBan, 'acc-1')).toBe(`${b.label} accountId acc-1?`);
    }
  });
});

describe('action messages', () => {
  it('confirms and reports the ban direction', () => {
    expect(banConfirm(true, 'acc-1')).toBe('Ban accountId acc-1?');
    expect(banMessage(true)).toBe('Player banned.');
    expect(banMessage(false)).toBe('Player unbanned.');
  });

  it('confirms a password reset by account', () => {
    expect(resetPasswordConfirm('acc-1')).toBe('Reset the password for accountId acc-1 to the entered value?');
  });
});

describe('search results', () => {
  it('renders a row’s three columns, dashing what is absent', () => {
    expect(summaryCells({ accountId: 'acc-1' })).toEqual({ publicId: '—', displayName: '—', loginId: '—' });
    expect(summaryCells(row)).toEqual({ publicId: '#123456789', displayName: 'Ada', loginId: 'ada@example.com' });
  });

  it('counts hits with correct pluralisation', () => {
    expect(resultsText(1)).toBe('1 result');
    expect(resultsText(3)).toBe('3 results');
  });
});
