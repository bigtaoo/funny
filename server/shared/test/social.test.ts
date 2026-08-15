// Unit tests for social.ts's deterministic id-derivation pure functions. The rest of social.ts is
// constants + interface/type declarations (erased at compile time; not executable, so not under test here).
import { describe, it, expect } from 'vitest';
import { conversationId, friendEdgeId, blockId } from '../src/social';

describe('conversationId', () => {
  it('both orderings produce the same id, with the lexicographically smaller accountId first', () => {
    expect(conversationId('acc-a', 'acc-b')).toBe('acc-a:acc-b');
    expect(conversationId('acc-b', 'acc-a')).toBe('acc-a:acc-b');
  });

  it('is stable for the same pair regardless of call order', () => {
    const id1 = conversationId('x', 'y');
    const id2 = conversationId('y', 'x');
    expect(id1).toBe(id2);
  });
});

describe('friendEdgeId', () => {
  it('is directed: owner first, friend second (order matters, unlike conversationId)', () => {
    expect(friendEdgeId('owner-1', 'friend-1')).toBe('owner-1:friend-1');
    expect(friendEdgeId('friend-1', 'owner-1')).toBe('friend-1:owner-1');
  });
});

describe('blockId', () => {
  it('is directed: owner first, target second', () => {
    expect(blockId('owner-1', 'target-1')).toBe('owner-1:target-1');
    expect(blockId('target-1', 'owner-1')).toBe('target-1:owner-1');
  });
});
