// Friend + private-chat service — small predicates shared by relations.ts and chat.ts (both need
// "are these two accounts blocked/friends" before acting; kept free functions rather than methods
// since neither depends on instance state, only the collections handed in by the caller).
import type { SocialCollections } from '../db';
import { friendEdgeId, blockId } from '@nw/shared';

export async function hasBlock(cols: SocialCollections, owner: string, target: string): Promise<boolean> {
  return !!(await cols.blockList.findOne({ _id: blockId(owner, target) }));
}

export async function isFriend(cols: SocialCollections, owner: string, friend: string): Promise<boolean> {
  return !!(await cols.friendEdges.findOne({ _id: friendEdgeId(owner, friend) }));
}
