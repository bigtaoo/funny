// Database seed for the layout sweep (portraitLayout.spec.ts). Turns the freshly-registered account
// the sweep drives into a MAXED-OUT one, by writing straight into the Docker stack's Mongo.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// The sweep's first two rounds walked 32 stops and found 17 real defects, but almost every stop was
// rendering an EMPTY state: a leaderboard of one, an auction with no listings, an inbox with no
// mail, a family tab that could not even be entered. Layouts do not break on empty tables — they
// break when content arrives, so an all-green sweep over a fresh account was mostly measuring the
// scaffolding. This module supplies the content.
//
// ── Why straight into Mongo, and not through the UI ─────────────────────────────────────────────
// Because the UI cannot produce most of it at all (a 40-member family needs 40 players; a top-100
// leaderboard needs 100 ranked accounts), and where it can, it costs minutes per stop per viewport.
// The documents are simple and their shapes are checked against the server's own Doc interfaces
// (socialsvc/src/db.ts, worldsvc/src/db/*.ts, auctionsvc/src/db.ts, shared/src/mongo/*.ts) — see
// seedFixtures.ts, which holds the shapes and nothing else.
//
// ── Why it is called by the spec, not run as a manual prerequisite ──────────────────────────────
// Two of the joins are live, not stored: socialsvc holds a family roster as bare accountIds and asks
// metaserver for the display names at read time, and every family/sect permission check compares
// against `leaderId`. So the roster's members must be REAL accounts, and the leader must be the
// account the browser is logged in as — which is a fresh random account minted seconds earlier by
// `registerAndEnterLobby`. A seed written ahead of time cannot know that id. Hence: the spec calls
// `seedAccount(page)` after login and `seedWorld(...)` after the world map has been visited once.
//
// ── Prerequisite ────────────────────────────────────────────────────────────────────────────────
// The Docker stack (`./docker/local-up.ps1`) — the same one playwright.portrait.config.ts points at.
// Its Mongo is the container `nw-local-mongo`, which publishes no port, so every write here goes
// through `docker exec`. Note `docker cp` is NOT usable from Git Bash (it mangles Windows paths into
// `/C:/Users/...`); the script is piped in on stdin instead.

import { execFileSync } from 'child_process';
import type { Page } from '@playwright/test';
import {
  ANNOUNCEMENT, FAMILY_NAME, FAMILY_TAG, SECT_NAME, SECT_TAG, LONG_NAMES,
  buildAuctions, buildInventory, buildMails, nameFor,
} from './seedFixtures';

/** The Mongo container in docker/docker-compose.local.yml. */
const CONTAINER = 'nw-local-mongo';

const DB_META = 'notebook_wars';
const DB_SOCIAL = 'nw_social';
const DB_WORLD = 'notebook_wars_world';
const DB_AUCTION = 'notebook_wars_auction';

/** How many other accounts the seed dresses up as roster/leaderboard/market population. */
const BOTS = 120;
/** FAMILY_CAP — a full family is the roster length that decides whether the member list scrolls or spills. */
const FAMILY_MEMBERS = 40;

export interface SeedTarget {
  accountId: string;
  /** Other real accounts the seed renamed and reused as family members / friends / sellers. */
  botIds: string[];
  familyId: string;
}

/**
 * Runs a script in the stack's Mongo and returns whatever it printed.
 *
 * The script arrives on **stdin**, for two reasons. It is far too big for a single `--eval` argv
 * entry (120 leaderboard rows, 48 cards, 44 listings), and piping it straight into `mongosh`'s own
 * stdin is worse than useless: that is the REPL, which echoes a `rs0 [direct: primary] db>` prompt
 * onto the same line as the script's output and evaluates line-by-line, so a multi-line `function`
 * or `if` block is at the mercy of its continuation detection. `sh -c 'cat > file && mongosh --file'`
 * spends one extra process to get an ordinary script run with ordinary script semantics.
 */
export function mongosh(db: string, script: string): string {
  return execFileSync('docker', [
    'exec', '-i', CONTAINER, 'sh', '-c',
    `cat > /tmp/nwseed.js && mongosh ${db} --quiet --file /tmp/nwseed.js`,
  ], { input: script, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** Marker the seed scripts prefix their one result line with — see `readResult`. */
const MARK = '@@NWSEED@@';

/**
 * Serialises a payload for the script. Plain JSON, plus one convention: an object shaped
 * `{ __date: <epoch ms> }` is revived as a BSON `Date` on the other side. Mongo's TTL indexes only
 * expire real Date fields, and several of these collections (mails, chatMessages, familyMessages)
 * anchor their TTL on one — a number there is not a slightly-wrong value, it is a document that
 * never expires and, for chat, one the reader sorts wrongly.
 */
function payload(value: unknown): string {
  return `const MARK = ${JSON.stringify(MARK)};
const P = (function revive(v) {
    if (Array.isArray(v)) return v.map(revive);
    if (v && typeof v === 'object') {
      if (typeof v.__date === 'number') return new Date(v.__date);
      const o = {};
      for (const k of Object.keys(v)) o[k] = revive(v[k]);
      return o;
    }
    return v;
  })(${JSON.stringify(value)});`;
}

/**
 * The script's own result line, found by its marker rather than by position — mongosh still emits
 * deprecation notices and driver warnings under `--quiet`, and a seed that silently parsed one of
 * those as its result would report success having written nothing.
 */
function readResult<T>(out: string): T {
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith(MARK));
  if (!line) throw new Error(`seed: mongosh printed no result:\n${out}`);
  return JSON.parse(line.slice(MARK.length)) as T;
}

/** The accountId the browser is logged in as — `save.accountId`, the JWT `sub` every service keys on. */
export async function accountIdOf(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    const raw = localStorage.getItem('nw_save_v1');
    if (!raw) return null;
    try { return (JSON.parse(raw) as { accountId?: string }).accountId ?? null; } catch { return null; }
  });
  if (!id) throw new Error('seed: no accountId in the local save — is the account logged in?');
  return id;
}

/** Epoch ms, hoisted so every relative timestamp in one seed agrees with the others. */
const now = Date.now();

/**
 * Phase one: everything that needs only an account.
 *
 * Leaves the account with a full hero roster, a full equipment stash, a full inbox, a full friend
 * list, a 40-member family it leads, a market with a page and a half of listings, and the top slot
 * on a leaderboard of 120 ranked players.
 */
export async function seedAccount(page: Page): Promise<SeedTarget> {
  const accountId = await accountIdOf(page);
  const inv = buildInventory(accountId, 48, 60);
  const mails = buildMails(accountId, 24);

  // Bot display names, and the ELO ladder they sit on. Descending from just under the account's own
  // so "my rank" is #1 and the rows below are four-digit and rank-varied (eloToRank's tiers start at
  // 2400 king / 2100 grandmaster / 1900 master …) — a fresh stack has 1677 accounts all sitting at
  // exactly 1000/"unranked", which renders the same three-character number 100 times.
  const names = Array.from({ length: BOTS }, (_, i) => nameFor(i));
  const elos = Array.from({ length: BOTS }, (_, i) => 2847 - i * 13);

  const script = `${payload({
    me: accountId,
    names,
    elos,
    familyId: `fam:${FAMILY_TAG}`,
    familyName: FAMILY_NAME,
    familyTag: FAMILY_TAG,
    announcement: ANNOUNCEMENT,
    familyMembers: FAMILY_MEMBERS,
    cards: inv.cards,
    equipment: inv.equipment,
    mails,
    now,
  })}
const meta    = db.getSiblingDB('${DB_META}');
const social  = db.getSiblingDB('${DB_SOCIAL}');
const auction = db.getSiblingDB('${DB_AUCTION}');

// Population: the first N other accounts by _id, so a re-run dresses up the SAME accounts rather
// than renaming a fresh batch every time and leaving a trail of them behind.
const bots = meta.accounts.find({ _id: { $ne: P.me } }, { projection: { _id: 1 } })
  .sort({ _id: 1 }).limit(P.names.length).toArray().map(function (d) { return d._id; });

const season = meta.ladderSeasons.findOne({ _id: 'current' });
const seasonNo = (season && season.seasonNo) || 1;
const TITLES = ['ladder.s' + seasonNo + '.king', 'event.founder', 'ach.all_chapters', 'ach.pvp.veteran'];
function rankOf(elo) {
  return elo >= 2400 ? 'king' : elo >= 2100 ? 'grandmaster' : elo >= 1900 ? 'master'
    : elo >= 1700 ? 'star' : elo >= 1500 ? 'diamond' : elo >= 1350 ? 'platinum'
    : elo >= 1200 ? 'gold' : elo >= 1100 ? 'silver' : 'bronze';
}

// ── Leaderboard population ────────────────────────────────────────────────────────────────────
const lb = [];
bots.forEach(function (id, i) {
  lb.push({ updateOne: { filter: { _id: id }, update: { $set: { displayName: P.names[i] } } } });
});
meta.accounts.bulkWrite(lb);

const saveOps = bots.map(function (id, i) {
  const elo = P.elos[i];
  return { updateOne: { filter: { _id: id }, update: { $set: {
    'save.pvp.elo': elo,
    'save.pvp.rank': rankOf(elo),
    'save.pvp.seasonNo': seasonNo,
    'save.pvp.seasonPeakElo': elo + 40,
    'save.pvp.seasonPeakRank': rankOf(elo + 40),
    'save.pvp.wins': 400 - i,
    'save.pvp.losses': 100 + i,
    // A leaderboard row prints the equipped title next to the name; leaving it unset renders the
    // widest column in the row as permanently empty.
    'save.equipped.title': TITLES[i % TITLES.length],
    'save.titles': TITLES,
  } } } };
});
meta.saves.bulkWrite(saveOps);

// ── The account itself ────────────────────────────────────────────────────────────────────────
meta.accounts.updateOne({ _id: P.me }, { $set: { displayName: ${JSON.stringify(LONG_NAMES[0])} } });
meta.saves.updateOne({ _id: P.me }, { $set: {
  // Seven-digit coins: the lobby/shop/auction coin chip is the single most reused number in the UI.
  'save.wallet.coins': 9876543,
  'save.materials': { scrap: 482300, lead: 96420, binding: 27180 },
  'save.inventory.items': { gacha_ticket: 1288, gacha_ticket_premium: 366 },
  'save.pvp.elo': 2960,
  'save.pvp.rank': 'king',
  'save.pvp.seasonNo': seasonNo,
  'save.pvp.seasonPeakElo': 3010,
  'save.pvp.seasonPeakRank': 'king',
  'save.pvp.wins': 1284,
  'save.pvp.losses': 317,
  'save.pvp.streak': 17,
  'save.titles': TITLES,
  'save.equipped.title': TITLES[0],
  // Clears chapter one, which is the lobby's only feature gate (ONBOARDING_DESIGN §4) — otherwise
  // the world entry renders greyed out with its tooltip bubble on every viewport.
  'save.progress.cleared': ['ch1_lv1','ch1_lv2','ch1_lv3','ch1_lv4','ch1_lv5','ch1_lv6','ch1_lv7','ch1_lv8','ch1_lv9','ch1_lv10'],
  'save.progress.stars': { ch1_lv1: 3, ch1_lv2: 3, ch1_lv3: 3, ch1_lv4: 3, ch1_lv5: 3, ch1_lv6: 3, ch1_lv7: 2, ch1_lv8: 3, ch1_lv9: 2, ch1_lv10: 3 },
  'save.cardInvCount': P.cards.length,
  'save.equipmentInvCount': P.equipment.length,
} });

// ── Inventory ─────────────────────────────────────────────────────────────────────────────────
meta.cardInstances.deleteMany({ accountId: P.me, _id: /^seedcard/ });
meta.equipmentInstances.deleteMany({ accountId: P.me, _id: /^seedeq/ });
meta.cardInstances.insertMany(P.cards);
meta.equipmentInstances.insertMany(P.equipment);

// ── Family (socialsvc; roster display names are joined live from meta, hence real accounts) ─────
social.families.deleteMany({ _id: P.familyId });
social.familyMembers.deleteMany({ familyId: P.familyId });
social.familyJoinRequests.deleteMany({ familyId: P.familyId });
social.familyMessages.deleteMany({ familyId: P.familyId });

const members = bots.slice(0, P.familyMembers - 1);
social.families.insertOne({
  _id: P.familyId, name: P.familyName, tag: P.familyTag, leaderId: P.me,
  memberCount: members.length + 1, announcement: P.announcement,
  prosperity: 184620, prosperityUpdatedAt: P.now, activity: 92840, territoryCount: 1284,
  emblemKey: 'crest_01', emblemColor: 0xC94F3D, createdAt: P.now - 86400000 * 40, rev: 1,
});
social.familyMembers.insertOne({ _id: P.me, familyId: P.familyId, accountId: P.me, role: 'leader', joinedAt: P.now - 86400000 * 40 });
social.familyMembers.insertMany(members.map(function (id, i) {
  return {
    _id: id, familyId: P.familyId, accountId: id,
    // Every role rendered: the roster row draws a role chip whose width differs per role.
    role: i < 2 ? 'elder' : 'member',
    joinedAt: P.now - 86400000 * (39 - i),
  };
}));
// Pending applications drive the leader's approve/reject row + the tab badge count.
social.familyJoinRequests.insertMany(bots.slice(P.familyMembers, P.familyMembers + 8).map(function (id, i) {
  return { _id: 'seedreq' + i, familyId: P.familyId, accountId: id, status: 'pending', createdAt: P.now - i * 600000 };
}));
social.familyMessages.insertMany(bots.slice(0, 30).map(function (id, i) {
  return {
    _id: 'fm:' + P.familyId + ':' + (P.now - i * 60000) + ':' + i,
    familyId: P.familyId, senderId: id, senderName: P.names[i],
    title: TITLES[i % TITLES.length], familyName: P.familyName,
    body: i % 3 === 0
      ? '今晚八点集合，未到者视为放弃本轮资源分配；Nachzügler bitte vorher Bescheid geben.'
      : '收到，' + (2000 + i * 137) + ' 兵已就位。',
    ts: new Date(P.now - i * 60000),
  };
}));

// ── Friends, requests and private chat ────────────────────────────────────────────────────────
social.friendEdges.deleteMany({ owner: P.me });
social.friendRequests.deleteMany({ to: P.me });
social.conversations.deleteMany({ members: P.me });
social.chatMessages.deleteMany({ _id: /^seedchat/ });
const friends = bots.slice(0, 30);
social.friendEdges.insertMany(friends.map(function (id, i) {
  return { _id: P.me + '|' + id, owner: P.me, friend: id, since: P.now - i * 86400000 };
}));
social.friendCounts.updateOne({ _id: P.me }, { $set: { count: friends.length } }, { upsert: true });
social.friendRequests.insertMany(bots.slice(40, 46).map(function (id, i) {
  return { _id: 'seedfr' + i, from: id, to: P.me, status: 'pending',
    message: '一起打跨服争霸吧，我们家族缺一个前排指挥。', createdAt: P.now - i * 3600000 };
}));
const convs = friends.slice(0, 12).map(function (id, i) {
  const cid = 'seedconv' + i;
  social.chatMessages.insertMany([0,1,2,3,4].map(function (k) {
    return { _id: 'seedchat' + i + '_' + k, convId: cid, from: k % 2 ? P.me : id,
      body: k % 2 ? 'Alles klar, ich bringe ' + (1200 + k * 311) + ' Einheiten mit.'
                  : '明天的攻城我带三队上，你负责北门佯攻，别提前暴露。',
      kind: 'text', ts: new Date(P.now - (5 - k) * 60000) };
  }));
  return { _id: cid, members: [P.me, id], lastBody: '明天的攻城我带三队上，你负责北门佯攻，别提前暴露。',
    lastFrom: id, lastTs: P.now - i * 300000, unread: (function () { const u = {}; u[P.me] = 3 + i; u[id] = 0; return u; })() };
});
social.conversations.insertMany(convs);

// ── Mail ──────────────────────────────────────────────────────────────────────────────────────
social.mails.deleteMany({ to: P.me });
social.mails.insertMany(P.mails);

// The chosen ids go back to the caller: the auction listings (and phase two's sect roster) need to
// address the same accounts, and duplicating the "first N by _id" rule on the Node side would be a
// second definition of the population that could silently drift from this one.
print(MARK + JSON.stringify({ ok: true, seasonNo: seasonNo, bots: bots }));
`;

  const res = readResult<{ ok: boolean; bots: string[] }>(mongosh(DB_META, script));
  if (!res.ok) throw new Error('seed: account phase did not report ok');
  const botIds = res.bots;

  // Its own database (auctionsvc is physically isolated — AUCTION_DESIGN §9), hence its own call.
  mongosh(DB_AUCTION, `${payload({ rows: buildAuctions(botIds, accountId, 44) })}
db.auctions.deleteMany({ _id: /^seedauc/ });
db.auctions.insertMany(P.rows);
print(MARK + JSON.stringify({ ok: true, listings: P.rows.length }));`);

  return { accountId, botIds, familyId: `fam:${FAMILY_TAG}` };
}

/**
 * Phase two: everything that needs a `PlayerWorldDoc`, i.e. everything the sweep's SLG stops render.
 *
 * Must run AFTER the account has opened the world map once — `joinWorld` is what allocates its shard,
 * its main base tile and its starting resources, and reproducing that allocation here would be
 * duplicating the one piece of worldsvc logic that actually has to be right.
 */
export async function seedWorld(page: Page, target: SeedTarget): Promise<void> {
  const { accountId, botIds, familyId } = target;
  const script = `${payload({
    me: accountId, botIds, familyId, familyName: FAMILY_NAME,
    sectName: SECT_NAME, sectTag: SECT_TAG, now,
  })}
const world  = db.getSiblingDB('${DB_WORLD}');
const social = db.getSiblingDB('${DB_SOCIAL}');
const meta   = db.getSiblingDB('${DB_META}');

const pw = world.playerWorld.findOne({ accountId: P.me });
if (!pw) { print(MARK + JSON.stringify({ ok: false, why: 'no playerWorld - has the world map been opened?' })); quit(0); }
const worldId = pw.worldId;
const sectId = 's:' + worldId + ':' + P.sectTag;
// A tile id is already fully qualified as worldId:x:y (worldsvc TileDoc._id), and
// mainBaseTile IS one - not a bare 'x,y' pair. Everything anchored below is expressed relative to
// it so the seeded marches, holds and territory land inside the viewport the map opens at.
const base = pw.mainBaseTile;
if (!base) { print(MARK + JSON.stringify({ ok: false, why: 'playerWorld has no mainBaseTile' })); quit(0); }
const baseParts = base.split(':');
const bx = parseInt(baseParts[baseParts.length - 2], 10);
const by = parseInt(baseParts[baseParts.length - 1], 10);
const tileAt = function (dx, dy) { return worldId + ':' + (bx + dx) + ':' + (by + dy); };

const cards = meta.cardInstances.find({ accountId: P.me }, { projection: { _id: 1 } }).limit(25).toArray()
  .map(function (d) { return d._id; });

// Five FULL teams: the city's team list and the world map's team panel both lay out per team, and a
// fresh account has one team with one card in it.
const teams = [];
const cardState = {};
const teamState = {};
for (let t = 0; t < 5; t++) {
  const army = [];
  for (let k = 0; k < 5; k++) {
    const cid = cards[t * 5 + k];
    if (!cid) continue;
    army.push({ cardInstanceId: cid, col: k % 3, row: Math.floor(k / 3) });
    cardState[cid] = { currentTroops: 24800 + t * 1300 + k * 170, teamId: 't' + (t + 1) };
  }
  teams.push({
    id: 't' + (t + 1),
    // Team names at the field's own cap, since the team row is one of the tightest in the game.
    name: ['破晓先锋营', '玄武重甲卫', 'Sturmvorhut', '墨鸦游击队', 'Nachtwache'][t],
    army,
    leaderCardId: army.length ? army[0].cardInstanceId : undefined,
    autoReturn: t % 2 === 0,
  });
  // One team injured, so its "injured until" state renders alongside four healthy ones.
  teamState['t' + (t + 1)] = t === 3
    ? { injuredUntil: P.now + 1800000, stamina: 0, staminaAt: P.now }
    : { stamina: 100 - t * 7, staminaAt: P.now };
}

world.playerWorld.updateOne({ _id: pw._id }, { $set: {
  troops: 1482600,
  troopCap: 1600000,
  resources: { ink: 8420000, paper: 6318000, graphite: 4270500, metal: 2860400, sticker: 918300 },
  yieldRate: { ink: 128400, paper: 96200, graphite: 74100, metal: 51800, sticker: 12600 },
  lastTickAt: P.now,
  familyId: P.familyId,
  sectId: sectId,
  sectSince: P.now - 86400000 * 30,
  teams: teams,
  teamState: teamState,
  cardState: cardState,
  hasBattlePass: true,
  // Every building at a two-digit level, and both queues busy — the city screen's empty middle band
  // (the §49 finding that only a screenshot could show) is a property of the EMPTY city.
  buildings: { desk: 10, inkPot: 18, paperTray: 17, graphiteMill: 16, metalForge: 15,
               stickerShop: 14, cabinet: 19, drillYard: 20, wall: 18, academy: 13, satchel: 12 },
  buildQueue: [
    { key: 'wall', toLevel: 19, startAt: P.now - 600000, completeAt: P.now + 5400000 },
    { key: 'academy', toLevel: 14, startAt: P.now - 300000, completeAt: P.now + 9600000 },
  ],
  nextBuildCompleteAt: P.now + 5400000,
  trainingQueue: [
    { qty: 128400, inkCost: 462000, startAt: P.now - 900000, completeAt: P.now + 2700000 },
    { qty: 96200, inkCost: 318000, startAt: P.now - 600000, completeAt: P.now + 4200000 },
    { qty: 74800, inkCost: 254000, startAt: P.now - 120000, completeAt: P.now + 7200000 },
  ],
  nextTrainingCompleteAt: P.now + 2700000,
} });

// ── Sect (worldsvc) + the mirror socialsvc keeps on the family ────────────────────────────────
world.sects.deleteMany({ _id: sectId });
world.sects.insertOne({
  _id: sectId, worldId: worldId, name: P.sectName, tag: P.sectTag,
  leaderFamilyId: P.familyId, leaderId: P.me, memberFamilyCount: 12,
  allySectIds: [], prosperity: 1284600,
  emblemKey: 'crest_07', emblemColor: 0x3D6FC9, rev: 1,
});
social.families.updateOne({ _id: P.familyId }, { $set: { sectId: sectId, sectName: P.sectName } });

// Other families inside the sect, so the sect roster is a list rather than one row. Their leaders
// are real accounts for the same live-display-name-join reason the main family's members are.
const allyFamilies = [];
for (let i = 0; i < 11; i++) {
  const tag = 'SF' + (10 + i);
  const leader = P.botIds[60 + i];
  if (!leader) break;
  allyFamilies.push({
    _id: 'fam:' + tag, name: ['苍梧行会','断章书社','Tintenbund','浮舟客栈','逐月盟','Federkiel','孤灯夜读','铅字工坊','Randnotiz','拂晓号角','墨痕阁'][i],
    tag: tag, leaderId: leader, memberCount: 8 + i, prosperity: 90000 - i * 5200,
    prosperityUpdatedAt: P.now, activity: 40000 - i * 1700, territoryCount: 300 - i * 12,
    sectId: sectId, sectName: P.sectName, createdAt: P.now - 86400000 * 30, rev: 1,
  });
}
social.families.deleteMany({ _id: { $in: allyFamilies.map(function (f) { return f._id; }) } });
if (allyFamilies.length) social.families.insertMany(allyFamilies);

world.sectMessages.deleteMany({ sectId: sectId });
world.sectMessages.insertMany(P.botIds.slice(0, 24).map(function (id, i) {
  return { _id: 'sm:' + sectId + ':' + (P.now - i * 90000) + ':' + i, worldId: worldId, sectId: sectId,
    senderId: id, senderName: ${JSON.stringify(LONG_NAMES[0])},
    sectName: P.sectName, familyName: P.familyName,
    body: i % 2 ? '中央城已经掉到 42% 耐久，主力别再分散了。'
                : 'Sammelpunkt ist die Provinzhauptstadt im Osten, 20:00 Uhr serverzeit.',
    ts: new Date(P.now - i * 90000) };
}));

// World channel, which is what the sweep's chat stop actually renders.
world.nationMessages.deleteMany({ worldId: worldId, _id: /^nm:/ });
world.nationMessages.insertMany(P.botIds.slice(0, 30).map(function (id, i) {
  return { _id: 'nm:' + worldId + ':' + (P.now - i * 45000) + ':' + i, worldId: worldId,
    senderId: id, senderName: ${JSON.stringify(LONG_NAMES[2])}, senderPublicId: String(100000000 + i),
    sectName: P.sectName, familyName: P.familyName,
    body: i % 3 === 0
      ? '收人！只要活跃，资源管够，私聊我，长期在线的优先，Anfänger willkommen。'
      : '北境三城已经易主，别再往那边送队了。',
    ts: new Date(P.now - i * 45000) };
}));

// ── Territory, marches, holds and stationed teams ─────────────────────────────────────────────
// The map is the one stop where the fresh account renders a genuinely empty world: no owned tiles,
// no tokens, no siege. All of these are anchored to the account's OWN base tile so they land inside
// the viewport the map opens at.
const owned = [];
for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
  if (dx === 0 && dy === 0) continue;
  owned.push(tileAt(dx, dy));
}
world.tiles.updateMany({ _id: { $in: owned } },
  { $set: { ownerId: P.me, familyId: P.familyId, garrison: 48200 } });

world.marches.deleteMany({ ownerId: P.me });
const marchSpecs = [
  { team: 't1', kind: 'attack', dx: 6, dy: -2 },
  { team: 't2', kind: 'occupy', dx: -7, dy: 3 },
  { team: 't3', kind: 'move', dx: 4, dy: 6 },
  { team: 't5', kind: 'return', dx: -5, dy: -6 },
];
world.marches.insertMany(marchSpecs.map(function (m, i) {
  const to = tileAt(m.dx, m.dy);
  const tx = bx + m.dx, ty = by + m.dy;
  return {
    _id: 'seedmarch' + i, worldId: worldId, ownerId: P.me, fromTile: base, toTile: to,
    kind: m.kind, troops: 148200 + i * 9100, teamId: m.team, leaderUnitType: 'infantry',
    morale: 100 - i * 9,
    departAt: P.now - 300000, arriveAt: P.now + (600000 + i * 300000),
    status: 'marching',
    minX: Math.min(bx, tx), maxX: Math.max(bx, tx), minY: Math.min(by, ty), maxY: Math.max(by, ty),
    rev: 1,
  };
}));

world.occupations.deleteMany({ ownerId: P.me });
world.occupations.insertOne({
  _id: tileAt(2, -5), worldId: worldId, ownerId: P.me, familyId: P.familyId,
  tile: tileAt(2, -5), x: bx + 2, y: by - 5, level: 7, resType: 'graphite',
  garrison: 96400, dueAt: P.now + 1200000, teamId: 't4', leaderUnitType: 'archer',
});

world.stationed.deleteMany({ ownerId: P.me });
world.stationed.insertOne({
  _id: tileAt(-2, 4), worldId: worldId, ownerId: P.me, familyId: P.familyId,
  tile: tileAt(-2, 4), x: bx - 2, y: by + 4, teamId: 't4',
  army: teams[3].army, troops: 118600, sinceAt: P.now - 3600000,
  leaderUnitType: 'cavalry', mode: 'garrison',
});

// Under siege: an incoming enemy march at the account's own base, which is the state the map HUD
// and the base panel both have a dedicated (and never-swept) layout for.
world.marches.insertOne({
  _id: 'seedsiege0', worldId: worldId, ownerId: P.botIds[0], fromTile: tileAt(9, 9), toTile: base,
  kind: 'attack', troops: 268400, teamId: 't1', leaderUnitType: 'cavalry', morale: 88,
  departAt: P.now - 120000, arriveAt: P.now + 480000, status: 'marching',
  minX: Math.min(bx, bx + 9), maxX: Math.max(bx, bx + 9),
  minY: Math.min(by, by + 9), maxY: Math.max(by, by + 9), rev: 1,
});

print(MARK + JSON.stringify({ ok: true, worldId: worldId, base: base, sectId: sectId }));
`;
  const res = readResult<{ ok: boolean; why?: string }>(mongosh(DB_WORLD, script));
  if (!res.ok) throw new Error(`seed: world phase failed — ${res.why ?? '?'}`);
  // The client caches the world payload for the session; a reload is the cheapest way to make the
  // seeded state the one the sweep's SLG stops actually render.
  await page.reload();
}
