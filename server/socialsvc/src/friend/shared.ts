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

/**
 * Release one friend slot on accountId's maintained counter (FriendCountDoc, db.ts). Guarded on
 * `count > 0` so it can never under-flow; no-op if the counter row doesn't exist yet — a future
 * ensureFriendCounter bootstrap recomputes the correct count from scratch regardless. Shared by
 * FriendRelationsService (removeFriend / claim rollback) and the account purge (accountPurge.ts),
 * which releases the slot each surviving friend had spent on the deleted account.
 */
export async function releaseFriendSlot(cols: SocialCollections, accountId: string): Promise<void> {
  await cols.friendCounts.updateOne({ _id: accountId, count: { $gt: 0 } }, { $inc: { count: -1 } });
}
