// Friend + private-chat service — small predicates shared by relations.ts and chat.ts (both need
// "are these two accounts blocked/friends" before acting; kept free functions rather than methods
// since neither depends on instance state, only the collections handed in by the caller).
import type { SocialCollections } from '../db';
import { friendEdgeId, blockId } from '@nw/shared';

export async function hasBlock(cols: SocialCollections, owner: string, target: string): Promise<boolean> {
  return !!(await cols.blockList.findOne({ _id: blockId(owner, target) }));
}

/** accountIds `owner` has blocked (Guideline 1.2 feed filtering). One indexed query on blockList.owner. */
export async function blockedTargets(cols: SocialCollections, owner: string): Promise<Set<string>> {
  const docs = await cols.blockList.find({ owner }, { projection: { target: 1 } }).toArray();
  return new Set(docs.map((d) => d.target));
}

export async function isFriend(cols: SocialCollections, owner: string, friend: string): Promise<boolean> {
  return !!(await cols.friendEdges.findOne({ _id: friendEdgeId(owner, friend) }));
}
