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
});
