// Live-ops player profile: titles (S10) + avatar/skin equip + preference flags. Split out of liveops.ts
// (2026-08-10, 独立函数模块 form — see liveops.ts's facade comment). The equip*/setFlag handlers take an
// explicit `ctx` (deps + `mutateSave`, bound by LiveOpsMixin's class body from its protected base
// method); getTitlesHandler only ever touched `this.deps`, so it takes plain `deps`. No behavior change.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SaveData } from '@nw/shared';
import { ErrorCode, err, ok, parseTitleId } from '@nw/shared';
import { getOrCreateSave, isAvatarOwned, isSkinOwned, PRESET_AVATAR_IDS } from '../../save.js';
import { accountIdOf, type ServiceDeps } from '../base.js';

/** Flag keys must be non-empty and reasonably short (dynamic namespace includes `featSeen.<featureId>`) — guards against a malformed client body writing garbage keys into the flags map. */
const MAX_FLAG_KEY_LEN = 100;

type MutateSaveFn = (
  accountId: string,
  transform: (s: SaveData) => SaveData | string,
) => Promise<{ save: SaveData } | { error: string }>;

export interface ProfileCtx {
  deps: ServiceDeps;
  mutateSave: MutateSaveFn;
}

/** Read all titles granted to the current account (including derived source/seasonNo) + currently equipped title. */
export async function getTitlesHandler(deps: ServiceDeps, req: FastifyRequest) {
  const accountId = accountIdOf(req);
  const save = await getOrCreateSave(deps.cols, accountId, deps.now());
  const titles = (save.titles ?? []).map((id) => {
    const { source, seasonNo } = parseTitleId(id);
    return { id, source, ...(seasonNo != null ? { seasonNo } : {}) };
  });
  return ok({ titles, equipped: save.equipped?.title ?? null });
}

/**
 * Select the active display title → write save.equipped.title → push back the full save.
 * Only granted titles are allowed; an empty string titleId is treated as unequipping (clears the equipped title).
 */
export async function equipTitleHandler(ctx: ProfileCtx, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { titleId } = req.body as { titleId?: string };
  const out = await ctx.mutateSave(accountId, (s) => {
    const owned = s.titles ?? [];
    // empty string = unequip display title
    if (titleId === '' || titleId == null) {
      const { title: _drop, ...restEquipped } = s.equipped ?? {};
      return { ...s, equipped: restEquipped };
    }
    if (!owned.includes(titleId)) return 'NOT_OWNED';
    return { ...s, equipped: { ...s.equipped, title: titleId } };
  });
  if ('error' in out) {
    if (out.error === 'NOT_OWNED') {
      return reply.code(403).send(err(ErrorCode.BAD_REQUEST, 'title not owned'));
    }
    return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
  }
  return ok({ save: out.save });
}

/**
 * Select the displayed avatar → write save.equipped.avatar → push back the full save.
 * avatarId is a composite "<category>:<key>" (preset/title/hero/equip/material/skin), with bare
 * digits ('0'-'7') accepted for backward compat with the old localStorage-only preset picker.
 * `preset` is always allowed; every other category requires the key to appear in the account's
 * lifetime-owned records (titles[] / everOwned.* / inventory.skins) — obtained once, unlocked forever,
 * even if the item has since been salvaged/consumed/sold.
 */
export async function equipAvatarHandler(ctx: ProfileCtx, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { avatarId } = req.body as { avatarId?: string };
  const out = await ctx.mutateSave(accountId, (s) => {
    if (avatarId === '' || avatarId == null) {
      const { avatar: _drop, ...restEquipped } = s.equipped ?? {};
      return { ...s, equipped: restEquipped };
    }
    if (PRESET_AVATAR_IDS.has(avatarId)) {
      return { ...s, equipped: { ...s.equipped, avatar: avatarId } };
    }
    if (!isAvatarOwned(s, avatarId)) return 'NOT_OWNED';
    return { ...s, equipped: { ...s.equipped, avatar: avatarId } };
  });
  if ('error' in out) {
    if (out.error === 'NOT_OWNED') {
      return reply.code(403).send(err(ErrorCode.BAD_REQUEST, 'avatar item not owned'));
    }
    return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
  }
  return ok({ save: out.save });
}

/**
 * Equip/unequip a character skin → write save.equipped["skin:<unitType>"] → push back the full save.
 * One slot per character (LOBBY_IA_REDESIGN §15); skinId null unequips. The unitType→skin target
 * mapping (SKIN_TARGET_UNIT) lives only in the client (game/meta/skinDefs.ts) — the server does not
 * need it here, it only validates that the *skin itself* is owned (isSkinOwned), same depth as the
 * old sanitizeEquipped path this replaces.
 */
export async function equipSkinHandler(ctx: ProfileCtx, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { unitType, skinId } = req.body as { unitType?: string; skinId?: string | null };
  if (!unitType) {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unitType required'));
  }
  const key = `skin:${unitType}`;
  const out = await ctx.mutateSave(accountId, (s) => {
    if (skinId === '' || skinId == null) {
      const rest = { ...s.equipped };
      delete rest[key];
      return { ...s, equipped: rest };
    }
    if (!isSkinOwned(s, skinId)) return 'NOT_OWNED';
    return { ...s, equipped: { ...s.equipped, [key]: skinId } };
  });
  if ('error' in out) {
    if (out.error === 'NOT_OWNED') {
      return reply.code(403).send(err(ErrorCode.BAD_REQUEST, 'skin not owned'));
    }
    return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
  }
  return ok({ save: out.save });
}

/**
 * Set one client-preference flag by key → write save.flags[key] → push back the full save.
 * No ownership semantics (unlike equipped.*) — onboarding/consent/tutorial-seen style booleans only.
 */
export async function setFlagHandler(ctx: ProfileCtx, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { key, value } = req.body as { key?: string; value?: boolean };
  if (!key || key.length > MAX_FLAG_KEY_LEN || typeof value !== 'boolean') {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'invalid key/value'));
  }
  const out = await ctx.mutateSave(accountId, (s) => ({ ...s, flags: { ...s.flags, [key]: value } }));
  if ('error' in out) {
    return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
  }
  return ok({ save: out.save });
}
