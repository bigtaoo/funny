// ADR-074 P1: settlement of a wild city's delayed durability hit, plus the capture that follows when the
// durability runs out. Split from combatSiege/damage.ts (which stays about TILE-scale building HP) because
// almost nothing is shared: a city is not a tile, has no owning account, and the capture writes sect
// ownership + announcements instead of relocating a base or handing a tile over.
//
// Called from `SiegeDamageService.settleSiegeDamage` when the claimed `SiegeDamageDoc` carries `cityId`.
import {
  playerWorldId,
  cityDurabilityMax,
  cityRegenPerHour,
  regenCityDurability,
  CITY_CAPTURE_PROTECTION_MS,
  type CityKind,
} from '@nw/shared';
import { randomBytes } from 'node:crypto';
import type { SiegeDamageDoc, CityDoc, SectMessageDoc, NationMessageDoc } from '../db';
import type { WorldCore } from '../core';
import { startReturnMarch } from '../combatShared';

/** Max optimistic-concurrency attempts for the durability write (same bound as the tile path). */
const MAX_ATTEMPTS = 5;

/**
 * Apply one delayed durability hit to a wild city, and capture it if that empties the wall.
 *
 * Ownership goes to the sect of the march that landed the LAST hit (ADR-074 decision 2 — the user's call
 * over "highest cumulative damage", accepting that it invites last-hit sniping). `siegeLog` still
 * accumulates per-sect damage so switching to the cumulative rule later needs no migration, and so the
 * client can show a contribution panel.
 *
 * Concurrency: a rev CAS with a bounded retry rather than a `$inc` pipeline, for the same reason the tile
 * path uses one — the new durability is not a pure function of the stored document (it folds in lazy regen
 * against the settlement timestamp), so recomputing against a fresh read is the correct semantics: whatever
 * hit landed in between is now visible and this one applies on top of it.
 */
export async function settleCityDamage(core: WorldCore, d: SiegeDamageDoc & { cityId: string }, t: number): Promise<void> {
  const { cols } = core.deps;
  const attackerSectId = d.attackerSectId;

  const returnSurvivors = async (): Promise<void> => {
    if (d.attackerSurvivors <= 0) return;
    const attacker = await cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, d.attackerId) });
    if (!attacker) return;
    await startReturnMarch(core, {
      worldId: d.worldId, ownerId: d.attackerId, fromTile: d.tile,
      x: core.coordX(d.tile), y: core.coordY(d.tile),
      troops: d.attackerSurvivors,
    }, t);
  };

  const city = await cols.cities.findOne({ _id: d.cityId });
  // Stale: city gone (world reset under us), the besieging sect already owns it (a sibling hit captured it
  // inside this same 5-minute window), the besieger has no sect on record, or the city is inside a
  // protection window opened by that sibling capture. Void the damage, walk the besiegers home.
  if (!city || !attackerSectId || city.ownerSectId === attackerSectId || (city.protectedUntil ?? 0) > t) {
    await returnSurvivors();
    return;
  }

  const damage = Math.max(0, Math.floor(d.damage));
  let cur: CityDoc = city;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Re-derive the caps from the level rather than trusting the stored snapshot: a map-editor publish or a
    // constant re-tune can have moved them since this document was written, and `initCities` only re-stamps
    // at season open.
    const kind = cur.kind as CityKind;
    const maxDurability = cityDurabilityMax(cur.level, kind);
    const regenPerHour = cityRegenPerHour(cur.level, kind);
    const live = regenCityDurability(cur.durability, maxDurability, cur.durabilityRegenAt, t, regenPerHour);
    const after = live - damage;
    const nextLog = { ...(cur.siegeLog ?? {}) };
    nextLog[attackerSectId] = (nextLog[attackerSectId] ?? 0) + damage;

    if (after > 0) {
      const res = await cols.cities.updateOne(
        { _id: cur._id, rev: cur.rev },
        {
          $set: {
            durability: Math.floor(after),
            durabilityMax: maxDurability,
            durabilityRegenAt: t,
            regenPerHour,
            siegeLog: nextLog,
          },
          $inc: { rev: 1 },
        },
      );
      if (res.matchedCount > 0) {
        await returnSurvivors();
        return;
      }
    } else {
      // Durability emptied → capture. The CAS doubles as the "who got there first" arbiter: only one
      // concurrent hit can match `rev`, so only one capture (and one announcement) can ever fire.
      const previousOwner = cur.ownerSectId;
      const sectName = await sectDisplayName(core, attackerSectId);
      const res = await cols.cities.updateOne(
        { _id: cur._id, rev: cur.rev },
        {
          $set: {
            ownerSectId: attackerSectId,
            ...(sectName ? { ownerSectName: sectName } : {}),
            capturedAt: t,
            protectedUntil: t + CITY_CAPTURE_PROTECTION_MS,
            // A captured city starts at full durability for its new owner — the same rule the tile path
            // applies on hand-over (`hp: maxHp`). Otherwise the sect that just paid for the assault would
            // hold a 0-durability city that anyone can flip back on the next hit.
            durability: maxDurability,
            durabilityMax: maxDurability,
            durabilityRegenAt: t,
            regenPerHour,
          },
          // The siege round is over: contribution history resets with ownership (§7).
          $unset: { siegeLog: '', defenderLock: '' },
          $inc: { rev: 1 },
        },
      );
      if (res.matchedCount > 0) {
        await returnSurvivors();
        await announceCapture(core, cur, attackerSectId, sectName, previousOwner, d.attackerId, t);
        return;
      }
    }
    const fresh = await cols.cities.findOne({ _id: cur._id });
    if (!fresh) { await returnSurvivors(); return; }
    cur = fresh;
  }
  console.error('[worldsvc] settleCityDamage: durability write lost the rev race every attempt', { city: d.cityId });
  await returnSurvivors();
}

async function sectDisplayName(core: WorldCore, sectId: string): Promise<string | undefined> {
  const doc = await core.deps.cols.sects.findOne({ _id: sectId }, { projection: { name: 1 } });
  return doc?.name;
}

/**
 * Capture announcements (§7). Three channels, deliberately NOT a mail fan-out to every member:
 *
 *  · **sect channel of the new owner** — "we took it", the channel that sect is actually reading;
 *  · **sect channel of the previous owner** (when there was one) — "we lost it", so a defender learns
 *    without needing a mail. A city is held by a sect, not an account, so there is no single defender to
 *    push an `under_attack` warning at;
 *  · **world channel** for the world center only, which is the one objective the whole shard cares about.
 *
 * Plus ONE system mail, to the player whose march landed the killing blow — a keepsake for the person who
 * actually did it. A sect can hold up to ~900 accounts (see `GW_PUSH_REDIS_CHANNEL`), so mailing the whole
 * membership on every capture of ~64 cities would be a faucet of mail, not a feature; the sect-channel
 * announcement already reaches everyone online and persists for the channel's 7-day TTL.
 *
 * All of it is best-effort: an announcement failure must never roll back a capture that already committed.
 */
async function announceCapture(
  core: WorldCore,
  city: CityDoc,
  newSectId: string,
  newSectName: string | undefined,
  previousSectId: string | undefined,
  attackerId: string,
  t: number,
): Promise<void> {
  const { cols } = core.deps;
  // i18n-key body, same convention as the season-settlement mail (`slg.settle.body|rank=1|...`): the
  // client renders it, so the server never picks a language.
  // Every param must be `name=value`: the client parser (i18n/systemText.ts) keys params off the `=`
  // and silently DROPS any pipe segment without one. These used to be positional, which meant the
  // level and the coordinates never reached the copy — the one thing a capture notice has to say.
  const cityRef = `kind=${city.kind}|node=${city.nodeId}|level=${city.level}|x=${city.x}|y=${city.y}`;
  const body = (key: string) => `${key}|${cityRef}|sect=${newSectName ?? newSectId}`;

  const postSect = async (sectId: string, key: string): Promise<void> => {
    const doc: SectMessageDoc = {
      _id: `sm:${sectId}:${t}:city:${randomBytes(4).toString('hex')}`,
      worldId: city.worldId,
      sectId,
      senderId: 'system',
      senderName: 'system',
      body: body(key),
      ts: new Date(t),
    };
    await cols.sectMessages.insertOne(doc);
    const recipients = await sectMemberAccountIds(core, city.worldId, sectId);
    if (recipients.length === 0) return;
    const payload = { sectId, fromPublicId: '', fromName: 'system', body: doc.body, ts: t };
    if (core.socialsvc.available) void core.socialsvc.push({ kind: 'sect', sectId }, 'sect_msg', payload, recipients);
    else void core.gateway.broadcast(recipients, { kind: 'sect_msg', ...payload });
  };

  try {
    await postSect(newSectId, 'slg.city.captured');
    if (previousSectId && previousSectId !== newSectId) await postSect(previousSectId, 'slg.city.lost');
    if (city.kind === 'worldCenter') {
      const doc: NationMessageDoc = {
        _id: `nm:${city.worldId}:${t}:city:${randomBytes(4).toString('hex')}`,
        worldId: city.worldId,
        senderId: 'system',
        senderName: 'system',
        senderPublicId: '',
        body: body('slg.city.worldCenterCaptured'),
        ts: new Date(t),
      };
      await cols.nationMessages.insertOne(doc);
      const worldMembers = (await cols.playerWorld.find({ worldId: city.worldId }, { projection: { accountId: 1 } }).toArray())
        .map((p) => p.accountId).filter((id): id is string => !!id);
      if (worldMembers.length > 0) {
        const payload = { worldId: city.worldId, fromPublicId: '', fromName: 'system', body: doc.body, ts: t };
        if (core.socialsvc.available) void core.socialsvc.push({ kind: 'world', worldId: city.worldId }, 'nation_msg', payload, worldMembers);
        else void core.gateway.broadcast(worldMembers, { kind: 'nation_msg', ...payload });
      }
    }
    void core.mail.sendSystemMail(attackerId, `city_capture:${city._id}:${t}`, {
      subject: 'slg.city.captured.subject',
      body: body('slg.city.captured.mail'),
    });
  } catch (e) {
    console.error('[worldsvc] city capture announcement failed (capture itself already committed)', {
      city: city._id, err: (e as Error).message,
    });
  }
}

/** Accounts of a sect's members who are joined to this world (mirrors sect/chat.ts's own private helper). */
async function sectMemberAccountIds(core: WorldCore, worldId: string, sectId: string): Promise<string[]> {
  const fams = await core.socialsvc.getFamiliesBySect(sectId).catch(() => []);
  const famIds = fams.map((f) => f.familyId);
  if (famIds.length === 0) return [];
  const docs = await core.deps.cols.playerWorld
    .find({ worldId, familyId: { $in: famIds } }, { projection: { accountId: 1 } })
    .toArray();
  return docs.map((d) => d.accountId).filter((id): id is string => !!id);
}
