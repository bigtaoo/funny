// socialsvc httpApi split — /internal/push (generic delegated push, called by worldsvc/metaserver) +
// /internal/presence/{online,offline} (called by gateway, P3) — grouped together because both are
// "notification fan-out" concerns, and presence's fan-out shares the same gateway.pushBatch primitive
// push uses. See ../httpApi.ts for the module overview. No behavior change — copied verbatim from the
// original httpApi.ts.
import { ErrorCode, ok } from '@nw/shared';
import type { FamilyService } from '../familyService';
import type { FriendService } from '../friendService';
import type { SocialGatewayClient, SocialPushMsg } from '../gatewayClient';
import { send, sendErr, readJson, type BaseCtx } from './helpers';

/**
 * Fan-out of friend online/offline notifications (P3, SOCIAL_SVC_DESIGN §5 Presence push chain).
 * Online: push "I came online" to online friends + push each online friend's status back to me.
 * Offline: only push "I went offline" to online friends (I am already disconnected, no need to push back to me).
 * All best-effort: failures do not affect the main flow.
 */
async function presenceFanOut(
  accountId: string,
  online: boolean,
  _familySvc: FamilyService,
  friendSvc: FriendService,
  gateway: SocialGatewayClient,
): Promise<void> {
  if (!gateway.available) return;
  const friendIds = await friendSvc.getFriendAccountIds(accountId);
  if (friendIds.length === 0) return;

  const myProfiles = await friendSvc.batchPublicIds([accountId]);
  const myPublicId = myProfiles.get(accountId);
  if (!myPublicId) return; // account has no publicId, skip broadcast

  const presenceMap = await gateway.presence(friendIds);
  const onlineFriendIds = friendIds.filter((id) => presenceMap[id]);
  if (onlineFriendIds.length === 0 && !online) return;

  // comm-audit batch F item 5: both fan-outs below used to be their own round trip(s) — "I came online/
  // offline" to every online friend (pushMany → N /gw/push calls) and, on coming online, each friend's
  // status pushed back to me (N more calls). Collapsed into a single targets[] batch (one /gw/push/batch
  // HTTP round trip covering all of it) instead of up to 2×onlineFriendIds.length individual pushes.
  const targets: { accountId: string; msg: SocialPushMsg }[] = [];

  // Push to online friends: I came online / went offline
  for (const fid of onlineFriendIds) {
    targets.push({ accountId: fid, msg: { kind: 'friend_presence', publicId: myPublicId, online } });
  }

  // On coming online: push each online friend's status back to me (so I know who is online)
  if (online && onlineFriendIds.length > 0) {
    const friendPids = await friendSvc.batchPublicIds(onlineFriendIds);
    for (const fid of onlineFriendIds) {
      const pid = friendPids.get(fid);
      if (pid) targets.push({ accountId, msg: { kind: 'friend_presence', publicId: pid, online: true } });
    }
  }

  if (targets.length > 0) await gateway.pushBatch(targets);
}

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleInternalPushRoutes(ctx: BaseCtx): Promise<boolean> {
  const { req, res, method, path, familySvc, friendSvc, gateway } = ctx;

  // Delegated push (called by worldsvc / metaserver, §4.2 /internal/push)
  if (method === 'POST' && path === '/internal/push') {
    const body = await readJson(req);
    const channel = body.channel as { kind: string; familyId?: string; sectId?: string; worldId?: string; accountId?: string } | undefined;
    const event = typeof body.event === 'string' ? body.event : '';
    const payload = body.payload;
    // targets: recipient list pre-computed by the caller (P1 interim fallback before sect/world channel Redis pub/sub is implemented in P3).
    const targets = Array.isArray(body.targets) ? (body.targets as string[]) : null;
    if (!channel || !event) { sendErr(res, ErrorCode.BAD_REQUEST, 'channel + event required'); return true; }

    const msg: SocialPushMsg = {
      kind: event as SocialPushMsg['kind'],
      ...(payload as object),
    } as SocialPushMsg;

    if (targets && targets.length > 0) {
      // Caller provided an explicit recipient list (sect/world channel P1 fallback).
      await gateway.pushMany(targets, msg);
    } else if (channel.kind === 'account' && channel.accountId) {
      await gateway.push(channel.accountId, msg);
    } else if (channel.kind === 'family' && channel.familyId) {
      // Push to all online family members (O(n), ≤30 members). No callerId passed (trusted internal
      // route) → getFamily returns the full member view with accountId always present.
      const detail = await familySvc.getFamily(channel.familyId);
      if (detail) {
        await gateway.pushMany(detail.members.map((m) => m.accountId!), msg);
      }
    }
    // sect/world channel with no targets: P3 will switch to Redis pub/sub routing (currently only persisted to DB, no real-time push).
    send(res, 200, ok({}));
    return true;
  }

  // Presence event (called by gateway, P3): fan-out of friend online/offline notifications
  if (method === 'POST' && (path === '/internal/presence/online' || path === '/internal/presence/offline')) {
    const body = await readJson(req);
    const presenceAccountId = typeof body.accountId === 'string' ? body.accountId : null;
    if (!presenceAccountId) { sendErr(res, ErrorCode.BAD_REQUEST, 'accountId required'); return true; }
    const isOnline = path.endsWith('/online');
    void presenceFanOut(presenceAccountId, isOnline, familySvc, friendSvc, gateway).catch(() => { /* best-effort */ });
    send(res, 200, ok({}));
    return true;
  }

  return false;
}
