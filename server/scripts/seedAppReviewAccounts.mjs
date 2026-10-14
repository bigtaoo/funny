#!/usr/bin/env node
// Seeds the two App Store review accounts with social content so every social page has something
// on it when Apple opens it (2026-10-14 rejection, Guideline 2.1(a): "demo accounts must include
// pre-populated content ... such as chat, friends"). See store-assets-checklist.md §1.2b.
//
// Idempotent: every step reads the current state first and only fills what is missing, so it is
// safe (and intended) to re-run before each submission — world/family/sect chat expire after 7 days,
// DMs and mail after 30.
//
// The main account must already exist. The second one is registered through the public
// `/api/auth/register` (the same path as the in-game Sign up) if it cannot log in yet. Passwords
// come from the environment only, never from this file:
//
//   NW_REVIEW_PASSWORD   password of appstore.review@gamestao.com  (the main demo account)
//   NW_REVIEW2_PASSWORD  password of appstore.review2@gamestao.com (defaults to NW_REVIEW_PASSWORD:
//                        both accounts share one password so reviewers only have one to type)
//
// Optional: NW_API_ORIGIN (default https://api.gamestao.com), NW_REVIEW_LOGIN, NW_REVIEW2_LOGIN,
// NW_REVIEW_FAMILY_TAG (default APRV), NW_REVIEW_SECT_TAG (default APRV).
//
// Costs real coins on the main account: 5000 for founding the sect (once) and 50 per world-chat
// post that is missing. review2 spends nothing.

const ORIGIN = (process.env.NW_API_ORIGIN ?? 'https://api.gamestao.com').replace(/\/$/, '');
const MAIN_LOGIN = process.env.NW_REVIEW_LOGIN ?? 'appstore.review@gamestao.com';
const SECOND_LOGIN = process.env.NW_REVIEW2_LOGIN ?? 'appstore.review2@gamestao.com';
const FAMILY_TAG = (process.env.NW_REVIEW_FAMILY_TAG ?? 'APRV').toUpperCase();
const SECT_TAG = (process.env.NW_REVIEW_SECT_TAG ?? 'APRV').toUpperCase();
const FAMILY_NAME = 'Ink Squad';
const SECT_NAME = 'Paper Pact';
const SECOND_DISPLAY_NAME = 'AppReview2';

const FAMILY_ANNOUNCEMENT = 'Welcome to Ink Squad! Weekly goal: clear chapter 2 together. Be kind in chat.';

// [speaker, body] — 'main' or 'second'. Clean, friendly English only.
const DM_SCRIPT = [
  ['second', 'Hi! Thanks for the friend request.'],
  ['main', 'Welcome! Want to try a friendly battle later?'],
  ['second', 'Sure, I am still learning the towers though.'],
  ['main', 'No problem, the ink walls are great for defense. Good luck!'],
];
const FAMILY_CHAT = [
  ['main', 'Hello family! Glad to have you here.'],
  ['second', 'Hi everyone, happy to join Ink Squad!'],
  ['main', 'Remember to collect your daily rewards.'],
];
const SECT_CHAT = [
  ['main', 'Welcome to Paper Pact, our sect is open to all friendly families.'],
  ['second', 'Thanks! Looking forward to the season.'],
];
const WORLD_CHAT = [
  ['main', 'Good luck to everyone this season!'],
  ['main', 'Any tips for chapter 3? The boss is tough.'],
];
const MAIL = [
  ['main', 'Welcome to Notebook Wars', 'Hi! Glad we are friends now. See you in the family chat.'],
  ['second', 'Thank you', 'Thanks for inviting me to Ink Squad!'],
];

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env ${name} (see the header of this script)`);
    process.exit(2);
  }
  return v;
}

class ApiError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

async function call(method, path, token, body) {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'accept-language': 'en',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed;
  try {
    parsed = await res.json();
  } catch {
    throw new ApiError(`HTTP_${res.status}`, `${method} ${path} returned non-JSON`);
  }
  if (!parsed.ok) {
    const err = parsed.error ?? {};
    throw new ApiError(err.code ?? `HTTP_${res.status}`, `${method} ${path}: ${err.message ?? 'failed'}`);
  }
  return parsed.data;
}

/** Channel reads come back either as a bare array or as `{ messages }`; only the bodies matter here. */
function bodiesOf(channel) {
  const list = Array.isArray(channel) ? channel : channel?.messages ?? [];
  return new Set(list.map((m) => m.body));
}

async function login(loginId, password) {
  const d = await call('POST', '/api/auth/login', undefined, { loginId, password });
  return { loginId, token: d.token, accountId: d.accountId, publicId: String(d.publicId), name: d.displayName ?? '' };
}

/** Logs in; on INVALID_CREDENTIALS registers the account instead (an existing account with a different password then fails on register with a clear error). */
async function loginOrRegister(loginId, password, displayName) {
  try {
    return await login(loginId, password);
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'INVALID_CREDENTIALS') throw e;
  }
  await call('POST', '/api/auth/register', undefined, { loginId, password, displayName });
  step(`registered ${loginId} as ${displayName}`);
  return login(loginId, password);
}

function step(msg) {
  console.log(`- ${msg}`);
}

async function ensureFriends(a, b) {
  const friends = await call('GET', '/api/friends', a.token);
  if (friends.friends.some((f) => String(f.publicId) === b.publicId)) return step('friends: already friends');
  const pending = await call('GET', '/api/friends/requests', b.token);
  let req = pending.incoming.find((r) => String(r.fromPublicId) === a.publicId);
  if (!req) {
    await call('POST', '/api/friends/request', a.token, { publicId: b.publicId, message: 'Hi, let us team up!' });
    req = (await call('GET', '/api/friends/requests', b.token)).incoming.find((r) => String(r.fromPublicId) === a.publicId);
  }
  if (!req) throw new Error('friend request not visible to the second account');
  await call('POST', '/api/friends/respond', b.token, { requestId: req.requestId, accept: true });
  step('friends: request sent and accepted');
}

async function ensureDms(who) {
  const convs = await call('GET', '/api/chat/conversations', who.main.token);
  if (convs.conversations.some((c) => String(c.peer?.publicId) === who.second.publicId)) {
    return step('DMs: conversation already exists');
  }
  for (const [speaker, body] of DM_SCRIPT) {
    const from = who[speaker];
    const to = speaker === 'main' ? who.second : who.main;
    await call('POST', '/api/chat/send', from.token, { toPublicId: to.publicId, body });
  }
  step(`DMs: sent ${DM_SCRIPT.length} messages`);
}

async function ensureFamily({ main, second }) {
  let fam = await call('GET', '/social/family/mine', main.token);
  if (!fam) {
    fam = await call('POST', '/social/family', main.token, { name: FAMILY_NAME, tag: FAMILY_TAG });
    step(`family: created ${fam.familyId}`);
  } else {
    step(`family: main is in ${fam.familyId}`);
  }
  if (fam.leaderId !== main.accountId) throw new Error(`main account is not the leader of ${fam.familyId}`);

  const secondFam = await call('GET', '/social/family/mine', second.token);
  if (secondFam && secondFam.familyId !== fam.familyId) {
    throw new Error(`second account is in another family (${secondFam.familyId}); leave it first`);
  }
  if (!secondFam) {
    try {
      await call('POST', `/social/family/${encodeURIComponent(fam.familyId)}/join`, second.token, {});
    } catch (e) {
      // A request left pending by an earlier run is fine — it is answered below.
      if (!(e instanceof ApiError) || !/ALREADY|PENDING|DUPLICATE/.test(e.code)) throw e;
    }
    const { requests } = await call('GET', '/social/family/requests', main.token);
    const req = requests.find((r) => r.accountId === second.accountId);
    if (!req) throw new Error('family join request from the second account not found');
    await call('POST', `/social/family/requests/${encodeURIComponent(req.requestId)}/respond`, main.token, { accept: true });
    step('family: second account joined');
  } else {
    step('family: second account already a member');
  }

  if (fam.announcement !== FAMILY_ANNOUNCEMENT) {
    await call('POST', '/social/family/announcement', main.token, { announcement: FAMILY_ANNOUNCEMENT });
    step('family: announcement set');
  }
  return fam.familyId;
}

async function fillChannel(label, script, who, readBodies, send) {
  const have = await readBodies();
  let sent = 0;
  for (const [speaker, body] of script) {
    if (have.has(body)) continue;
    await send(who[speaker], body);
    sent++;
  }
  step(`${label}: ${sent ? `posted ${sent}` : 'already populated'}`);
}

async function resolveWorldId(acct) {
  const { season } = await call('GET', '/world/active-season', acct.token);
  const { worldId } = await call('POST', '/world/season/resolve', acct.token, { season });
  return worldId;
}

async function ensureSect(main, worldId) {
  const fam = await call('GET', '/social/family/mine', main.token);
  if (fam.sectId) return step(`sect: family already in ${fam.sectId}`);
  const sects = await call('GET', `/sect/list?worldId=${encodeURIComponent(worldId)}`, main.token);
  const list = Array.isArray(sects) ? sects : sects?.sects ?? [];
  const existing = list.find((s) => s.tag === SECT_TAG && s.leaderFamilyId === fam.familyId);
  if (existing) {
    await call('POST', '/sect/join', main.token, { worldId, sectId: existing.sectId });
    return step(`sect: rejoined ${existing.sectId}`);
  }
  const sect = await call('POST', '/sect/create', main.token, { worldId, name: SECT_NAME, tag: SECT_TAG });
  step(`sect: created ${sect.sectId} (5000 coins)`);
}

async function ensureMail(who) {
  for (const [speaker, subject, body] of MAIL) {
    const from = who[speaker];
    const to = speaker === 'main' ? who.second : who.main;
    const inbox = await call('GET', '/api/mail', to.token);
    if (inbox.mail.some((m) => String(m.from) === from.publicId && m.subject === subject)) {
      step(`mail "${subject}": already in inbox`);
      continue;
    }
    await call('POST', '/api/mail/send', from.token, { toPublicId: to.publicId, subject, body });
    step(`mail "${subject}": sent`);
  }
}

async function main() {
  const mainAcct = await login(MAIN_LOGIN, need('NW_REVIEW_PASSWORD'));
  const second = await loginOrRegister(SECOND_LOGIN, process.env.NW_REVIEW2_PASSWORD || need('NW_REVIEW_PASSWORD'), SECOND_DISPLAY_NAME);
  const who = { main: mainAcct, second };
  console.log(`${ORIGIN}: main ${mainAcct.publicId}, second ${second.publicId}`);

  await ensureFriends(mainAcct, second);
  await ensureDms(who);

  const familyId = await ensureFamily(who);
  const famPath = `/social/family/${encodeURIComponent(familyId)}/messages`;
  await fillChannel('family chat', FAMILY_CHAT, who,
    async () => bodiesOf(await call('GET', `${famPath}?limit=50`, mainAcct.token)),
    (acct, body) => call('POST', famPath, acct.token, { body }));

  // Resolved after the family exists: shard choice prefers the family's shard, so both accounts land together.
  const worldId = await resolveWorldId(mainAcct);
  const secondWorld = await resolveWorldId(second);
  if (secondWorld !== worldId) console.warn(`! second account resolved to ${secondWorld}, main to ${worldId}`);
  step(`world: ${worldId}`);

  await ensureSect(mainAcct, worldId);
  await fillChannel('sect chat', SECT_CHAT, who,
    async () => bodiesOf(await call('GET', `/sect/channel?worldId=${encodeURIComponent(worldId)}&limit=50`, mainAcct.token)),
    (acct, body) => call('POST', '/sect/message', acct.token, { worldId, body, senderName: acct.name }));
  await fillChannel('world chat', WORLD_CHAT, who,
    async () => bodiesOf(await call('GET', `/nation/channel?worldId=${encodeURIComponent(worldId)}&limit=50`, mainAcct.token)),
    (acct, body) => call('POST', '/nation/message', acct.token, { worldId, body, senderName: acct.name }));

  await ensureMail(who);
  console.log('done');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
