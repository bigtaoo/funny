// profileRename (2026-08-11 split of service/auth.ts — see auth.ts's shell comment for the overall
// split rationale/module map). Takes `core: MetaCore` directly (2026-08-11 ctx-bind cleanup — see
// base.ts's header, for `core.ensureCommercial`).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ErrorCode, err, ok } from '@nw/shared';
import { regionFromAcceptLanguage, censorChat } from '@nw/shared';
import { validateDisplayName } from '@nw/shared';
import { RENAME_COST } from '@nw/shared';
import { getOrCreateSave } from '../../save.js';
import { hasFreeRename, setDisplayName } from '../../accounts.js';
import { mirrorCoins } from '../../economy.js';
import { accountIdOf, clientPlatformOf, type MetaCore } from '../base.js';

/**
 * Change display name. The first rename for a player who never deliberately chose a name (guests,
 * WeChat/OAuth, or password users who skipped the name field — their current name is a system-assigned
 * default) is **free**; every rename after that costs RENAME_COST coins. Requires login; the paid path
 * additionally requires the commercial service.
 */
export async function profileRenameHandler(core: MetaCore, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { displayName } = req.body as { displayName: string };
  const nameErr = validateDisplayName(displayName);
  if (nameErr) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, nameErr));
  const name = displayName.trim();

  // UGC governance (COMPLIANCE_GLOBAL.md §7): the design doc has long said displayName rename "should go
  // through the same filter" as private chat, but this handler never actually called it — displayName is
  // persistent and shown to every other player who sees this account, unlike an ephemeral chat message, so
  // (unlike censorChat's mask-and-deliver policy for chat) a hit here REJECTS the rename outright rather
  // than saving a masked "****" as a permanent name. Checked before the paid path spends any coins.
  const region = regionFromAcceptLanguage(req.headers['accept-language']);
  if (censorChat(name, region, core.deps.wordlists ?? undefined).hit) {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'display name contains disallowed words'));
  }

  const { cols, commercial, now } = core.deps;

  // One-time free rename for players who still carry a default name (never chose one).
  if (await hasFreeRename(cols, accountId)) {
    await setDisplayName(cols, accountId, name); // also marks nameChosen → subsequent renames are paid
    const save = await getOrCreateSave(cols, accountId, now());
    return ok({ save, displayName: name, freeRename: false });
  }

  if (!core.ensureCommercial(reply)) return;
  const orderId = randomUUID();
  const charge = await commercial.spend({ accountId, amount: RENAME_COST, reason: 'rename', orderId, clientPlatform: clientPlatformOf(req) });
  if (!charge.ok) {
    if (charge.error === 'INSUFFICIENT_FUNDS') {
      return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
    }
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, charge.error));
  }
  await setDisplayName(cols, accountId, name);
  const save = await mirrorCoins(cols, accountId, charge.coinsAfter, now());
  return ok({ save, displayName: name, freeRename: false });
}
