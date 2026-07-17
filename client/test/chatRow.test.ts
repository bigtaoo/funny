// chatNameLabel: the [title][sect][family]name prefix shared by World/Family/Sect chat rows
// (client/src/render/chatRow.ts). Bracket segments must be omitted entirely when the
// corresponding field is absent — most chats only ever populate a subset (see UI_DESIGN.md §21).
import { describe, it, expect } from 'vitest';
import { chatNameLabel } from '../src/render/chatRow';

describe('chatNameLabel', () => {
  it('bare name when no title/sect/family present', () => {
    expect(chatNameLabel({ senderName: 'tao' })).toBe('tao');
  });

  it('all three brackets, in [title][sect][family] order', () => {
    expect(chatNameLabel({
      senderName: 'tao', title: 'Grandmaster', sectName: 'IronSect', familyName: 'WangFam',
    })).toBe('[Grandmaster][IronSect][WangFam]tao');
  });

  it('omits a middle bracket (sectName) when only title + familyName are present', () => {
    expect(chatNameLabel({ senderName: 'tao', title: 'Grandmaster', familyName: 'WangFam' }))
      .toBe('[Grandmaster][WangFam]tao');
  });

  it('single bracket (familyName only)', () => {
    expect(chatNameLabel({ senderName: 'tao', familyName: 'WangFam' })).toBe('[WangFam]tao');
  });

  it('empty-string fields are treated as absent (not rendered as empty brackets)', () => {
    expect(chatNameLabel({ senderName: 'tao', title: '', sectName: '', familyName: '' })).toBe('tao');
  });

  it('resolves a raw titleId to its short display label (not the raw key)', () => {
    // Server sends the equipped titleId (e.g. event.newbie); the tag must show the
    // localized short name, never the internal key.
    const label = chatNameLabel({ senderName: 'tao', title: 'event.newbie' });
    expect(label).not.toContain('event.newbie');
    expect(label.endsWith('tao')).toBe(true);
    expect(label.startsWith('[')).toBe(true);
  });
});

// Title resolution: chatNameLabel must never leak a raw titleId into the tag — every
// title source (event / achievement / ladder / slg) resolves to its short i18n label.
// Test locale defaults to zh (client/src/i18n/index.ts), so labels are the zh short names.
describe('chatNameLabel — title resolution', () => {
  it.each([
    ['event.newbie', '新手'],
    ['event.founder', '先行者'],
    ['ach.all_chapters', '征服者'],
    ['ach.pvp.veteran', '老兵'],
    ['slg.s3.champion', '霸主'],
    ['slg.s3.top3', '前三'],
    ['ladder.s5.gold', '天梯'],
  ])('resolves %s → [%s]', (titleId, short) => {
    expect(chatNameLabel({ senderName: 'tao', title: titleId })).toBe(`[${short}]tao`);
  });

  it('an unknown titleId passes through unchanged (no crash, no empty tag)', () => {
    expect(chatNameLabel({ senderName: 'tao', title: 'Grandmaster' })).toBe('[Grandmaster]tao');
  });

  it('resolved title composes with sect + family brackets in order', () => {
    expect(chatNameLabel({
      senderName: 'tao', title: 'event.newbie', sectName: 'IronSect', familyName: 'WangFam',
    })).toBe('[新手][IronSect][WangFam]tao');
  });
});
