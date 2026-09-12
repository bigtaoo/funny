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
  buildAuctions, buildInventory, buildMails, nameFor, tagOf,
} from './seedFixtures';

/** The Mongo container in docker/docker-compose.local.yml. */
const CONTAINER = 'nw-local-mongo';
/**
 * Root credentials, straight out of that compose file (`MONGO_INITDB_ROOT_USERNAME` /
 * `_PASSWORD` — they are in the repo, and deliberately so: the point of local auth is per-service
 * least privilege, not secrecy). Root rather than a service user because this seed writes across
 * four databases and every service user is scoped to exactly one.
 *
 * Not optional since 2026-09-12, when auth was turned on for the local stack. Before that this
 * module connected anonymously and worked — not because it was allowed to, but because Mongo grants
 * a localhost exception to a data volume that has no users yet. The first `docker compose up` after
 * the change provisions them, and every anonymous read then fails with `requires authentication`.
 */
const MONGO_USER = process.env.NW_MONGO_USER ?? 'root';
const MONGO_PASS = process.env.NW_MONGO_PASS ?? 'localdev-root';

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
  const auth = `-u ${MONGO_USER} -p ${MONGO_PASS} --authenticationDatabase admin`;
  return execFileSync('docker', [
    'exec', '-i', CONTAINER, 'sh', '-c',
    `cat > /tmp/nwseed.js && mongosh ${db} ${auth} --quiet --file /tmp/nwseed.js`,
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
    // Scopes every fixed _id this phase mints — see seedFixtures.tagOf for the collision it fixes.
    tag: tagOf(accountId),
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
  return { _id: 'seedfr' + P.tag + i, from: id, to: P.me, status: 'pending',
    message: '一起打跨服争霸吧，我们家族缺一个前排指挥。', createdAt: P.now - i * 3600000 };
}));
const convs = friends.slice(0, 12).map(function (id, i) {
  const cid = 'seedconv' + P.tag + i;
  social.chatMessages.insertMany([0,1,2,3,4].map(function (k) {
    return { _id: 'seedchat' + P.tag + i + '_' + k, convId: cid, from: k % 2 ? P.me : id,
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
    sectName: SECT_NAME, sectTag: SECT_TAG, now, tag: tagOf(accountId),
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

// defId AND level come along because a card's troop capacity depends on both: cardTroopCap
// (shared/src/cards.ts, mirrored in client/src/game/meta/cardDefs.ts) is
// troopCapBase + troopCapGrowth x (level-1), level clamped to MAX_CARD_LEVEL 9 - i.e. 600 for a
// maxed lichuang, 300 for every other maxed card, and 200/100 for a level-1 one.
//
// Level is not a formality here: the 25 cards picked up below are whatever the account holds, and
// the first few of those are the FTUE starter cards at level 1, not the level-60 ones this seed
// wrote. Allotting every card the maxed figure printed 'Troops 1500/1300' on the city's team strip
// - more troops carried than the team can hold, which is a state the game cannot produce.
const cards = meta.cardInstances.find({ accountId: P.me }, { projection: { _id: 1, defId: 1, level: 1 } }).limit(25).toArray();
const cardTroopCap = function (card) {
  const base = card.defId === 'lichuang' ? 200 : 100;
  const growth = card.defId === 'lichuang' ? 50 : 25;
  const lv = Math.max(1, Math.min(Math.floor(card.level || 1), 9));
  return base + growth * (lv - 1);
};

// Five FULL teams: the city's team list and the world map's team panel both lay out per team, and a
// fresh account has one team with one card in it.
const teams = [];
const cardState = {};
const teamState = {};
for (let t = 0; t < 5; t++) {
  const army = [];
  for (let k = 0; k < 5; k++) {
    const card = cards[t * 5 + k];
    if (!card) continue;
    const cid = card._id;
    army.push({ cardInstanceId: cid, col: k % 3, row: Math.floor(k / 3) });
    // Every card carrying exactly its own cap, so the team strip reads '1500/1500' rather than a
    // number the game cannot reach. The first version wrote ~25000 per card and the strip duly
    // rendered 'Troops 125700/1300' - the numerator fiction, the denominator the real cap - which
    // is how a fixture turns into a layout finding nobody can act on.
    cardState[cid] = { currentTroops: cardTroopCap(card), teamId: 't' + (t + 1) };
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

// Every number below is at the game's OWN ceiling, not at an invented one (2026-09-12 correction —
// the first version was 10x to 100x past every cap here, which made the city and world-map findings
// measurements of the fixture rather than of the layout):
//   troopCap   troopCapFor({drillYard:10}) = TROOP_CAP_BASE 5000 + 10 x 1500 = 20000
//   resources  RESOURCE_CAP 200000 x (1 + cabinet 10 x 0.20) = 600000 per resource
//   yieldRate  RESOURCE_YIELD_BASE 100 x tile level, summed over the ~13 seeded resource tiles
//   buildings  BUILDING_MAX_LEVEL = DESK_MAX_LEVEL = 10 for every key
//   training   TROOP_TRAIN_BATCH_MAX 5000 per batch, ink cost TROOP_TRAIN_INK_COST 10 each
world.playerWorld.updateOne({ _id: pw._id }, { $set: {
  troops: 19840,
  troopCap: 20000,
  resources: { ink: 598400, paper: 596200, graphite: 594100, metal: 591800, sticker: 588300 },
  yieldRate: { ink: 2400, paper: 1900, graphite: 1500, metal: 1200, sticker: 800 },
  lastTickAt: P.now,
  familyId: P.familyId,
  sectId: sectId,
  sectSince: P.now - 86400000 * 30,
  teams: teams,
  teamState: teamState,
  cardState: cardState,
  hasBattlePass: true,
  // Every building at the cap, and both queues busy — the city screen's empty middle band (the §49
  // finding that only a screenshot could show) is a property of the EMPTY city. Two are left one
  // level short so the build queue has something legal to be building.
  buildings: { desk: 10, inkPot: 10, paperTray: 10, graphiteMill: 10, metalForge: 10,
               stickerShop: 10, cabinet: 10, drillYard: 10, wall: 9, academy: 9, satchel: 10 },
  buildQueue: [
    { key: 'wall', toLevel: 10, startAt: P.now - 600000, completeAt: P.now + 5400000 },
    { key: 'academy', toLevel: 10, startAt: P.now - 300000, completeAt: P.now + 9600000 },
  ],
  nextBuildCompleteAt: P.now + 5400000,
  // Three batches at TROOP_TRAIN_BATCH_MAX (drillYard 10 grants three parallel slots), each costing
  // qty x TROOP_TRAIN_INK_COST.
  trainingQueue: [
    { qty: 5000, inkCost: 50000, startAt: P.now - 900000, completeAt: P.now + 2700000 },
    { qty: 5000, inkCost: 50000, startAt: P.now - 600000, completeAt: P.now + 4200000 },
    { qty: 4820, inkCost: 48200, startAt: P.now - 120000, completeAt: P.now + 7200000 },
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
//
// These are INSERTED, not updated (2026-09-12 fix). worldsvc persists a TileDoc only for a tile that
// is owned or otherwise modified — "neutral default tiles are not persisted; computed by
// proceduralTile" (db/worldDocs.ts) — so the first version's updateMany over the 7x7 around the
// base matched exactly the 9 documents that DO exist there, which are the base's own 3x3 footprint
// (anchor + 8 baseRing cells, ADR-025). It therefore claimed no new land at all, and stamped a
// garrison onto ring cells, which by construction hold ownership and protection but no garrison.
//
// So: skip that 3x3 and upsert the remaining 40 as real settled territory — the same document
// settleOccupation writes (combatSiege/occupationSettle.ts), field for field. The one thing this
// cannot reproduce is proceduralTile's verdict on each cell (its level/resType, and whether the
// cell is water or city ground at all): that lives in TypeScript the seed cannot call from mongosh.
// The levels and resource types below are therefore a spread rather than the terrain's own answer —
// deliberate, because what the sweep needs from this stop is a populated territory list with the
// full range of level and yield digits in it, not a map that would survive a connectivity audit.
//
// (No backticks anywhere in this block: it lives inside the mongosh script's own template literal.)
const owned = [];
for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
  // The base footprint is already owned and must keep its own docs untouched.
  if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) continue;
  const id = tileAt(dx, dy);
  const n = owned.length;
  const doc = {
    _id: id, worldId: worldId, x: bx + dx, y: by + dy,
    type: 'territory', level: 1 + (n % 10),
    ownerId: P.me, familyId: P.familyId,
    // GARRISON_PER_TILE 500 is what an occupy pays; reinforcing adds to it, and the live value a
    // attacker meets is the higher of this and npcGarrison(level) = 120 x level. Low thousands, not tens.
    garrison: 500 + (n % 8) * 220, garrisonRegenAt: P.now - 600000,
    rev: 0,
  };
  // Every third tile carries a resource type, cycling all five (shared/src/slg/core.ts ResourceType)
  // so the yield column renders each icon and each digit width at least once.
  if (n % 3 === 0) doc.resType = ['ink', 'paper', 'graphite', 'metal', 'sticker'][(n / 3) % 5];
  owned.push(doc);
}
// One upsert per tile rather than an insertMany: the world is SHARED across every account the
// sweep has ever registered against this stack, so a cell here may already carry a document — and
// a blind insert would abort the whole batch on the first duplicate _id.
//
// Only two things are refused: a city node (city ground is siege-only, never claimable) and another
// player's base footprint. Ordinary territory belonging to an earlier seeded account is taken over,
// because those accounts are abandoned the moment their viewport's walk ends, and refusing them
// instead made this seed quietly weaker every time the sweep ran.
let ownedCount = 0;
let blocked = 0;
owned.forEach(function (doc) {
  const existing = world.tiles.findOne({ _id: doc._id });
  if (existing && (existing.baseRing || ['base', 'familyKeep', 'center'].indexOf(existing.type) >= 0)) {
    blocked++;
    return;
  }
  world.tiles.replaceOne({ _id: doc._id }, doc, { upsert: true });
  ownedCount++;
});
// Read back rather than trust the write count. What this has to catch is a wrong TileDoc SHAPE —
// the failure that let 'claimed 9 tiles, all of them the base's own footprint' stand for a round —
// and the only evidence of that is whether the documents are there afterwards. Deliberately NOT a
// threshold on how many tiles were offered: the first version guarded that instead and duly failed
// the whole sweep once the neighbourhood filled up with earlier accounts, which is a property of
// the stack, not a bug in the seed.
const verified = world.tiles.countDocuments({ worldId: worldId, ownerId: P.me, type: 'territory' });

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
    _id: 'seedmarch' + P.tag + i, worldId: worldId, ownerId: P.me, fromTile: base, toTile: to,
    // A march carries at most satchelCarryCapFor({satchel:10}) = 20000.
    kind: m.kind, troops: 4200 + i * 900, teamId: m.team, leaderUnitType: 'infantry',
    morale: 100 - i * 9,
    departAt: P.now - 300000, arriveAt: P.now + (600000 + i * 300000),
    status: 'marching',
    minX: Math.min(bx, tx), maxX: Math.max(bx, tx), minY: Math.min(by, ty), maxY: Math.max(by, ty),
    rev: 1,
  };
}));

// Upsert, for the same reason the siege march above is cleared by index key: these are keyed by
// TILE id, and on a shared world an earlier seeded account's base may have sat near this one.
world.occupations.deleteMany({ ownerId: P.me });
world.occupations.replaceOne({ _id: tileAt(2, -5) }, {
  _id: tileAt(2, -5), worldId: worldId, ownerId: P.me, familyId: P.familyId,
  tile: tileAt(2, -5), x: bx + 2, y: by - 5, level: 7, resType: 'graphite',
  garrison: 1860, dueAt: P.now + 1200000, teamId: 't4', leaderUnitType: 'archer',
}, { upsert: true });

world.stationed.deleteMany({ ownerId: P.me });
world.stationed.replaceOne({ _id: tileAt(-2, 4) }, {
  _id: tileAt(-2, 4), worldId: worldId, ownerId: P.me, familyId: P.familyId,
  tile: tileAt(-2, 4), x: bx - 2, y: by + 4, teamId: 't4',
  army: teams[3].army, troops: 4820, sinceAt: P.now - 3600000,
  leaderUnitType: 'cavalry', mode: 'garrison',
}, { upsert: true });

// Under siege: an incoming enemy march at the account's own base, which is the state the map HUD
// and the base panel both have a dedicated (and never-swept) layout for.
// Cleared by the UNIQUE INDEX KEY, not by _id: marches carry a unique index on
// (worldId, ownerId, teamId) - one live march per team per owner - so a leftover siege from an
// earlier seeded account on this same shard collides no matter what _id this one gets. That is
// exactly how the first full ten-viewport run died: six of the ten never got past seedWorld
// (E11000 on worldId_1_ownerId_1_teamId_1), and it looked intermittent only because accounts land
// on different shards.
world.marches.deleteMany({ worldId: worldId, ownerId: P.botIds[0], teamId: 't1' });
world.marches.insertOne({
  _id: 'seedsiege' + P.tag, worldId: worldId, ownerId: P.botIds[0], fromTile: tileAt(9, 9), toTile: base,
  kind: 'attack', troops: 18600, teamId: 't1', leaderUnitType: 'cavalry', morale: 88,
  departAt: P.now - 120000, arriveAt: P.now + 480000, status: 'marching',
  minX: Math.min(bx, bx + 9), maxX: Math.max(bx, bx + 9),
  minY: Math.min(by, by + 9), maxY: Math.max(by, by + 9), rev: 1,
});

print(MARK + JSON.stringify({ ok: true, worldId: worldId, base: base, sectId: sectId, ownedTiles: ownedCount, blockedTiles: blocked, verifiedTiles: verified }));
`;
  const res = readResult<{
    ok: boolean; why?: string; ownedTiles?: number; blockedTiles?: number; verifiedTiles?: number;
  }>(mongosh(DB_WORLD, script));
  if (!res.ok) throw new Error(`seed: world phase failed — ${res.why ?? '?'}`);
  // 40 tiles are offered (the 7x7 around the base, less its own 3x3); a city node or another base's
  // footprint can refuse a few. What must hold is that every tile this WROTE is readable back as
  // owned territory afterwards — that is the assertion about the document shape, and the reason it
  // exists is that the first version wrote 40 updates, matched 9 documents, changed nothing anyone
  // wanted changed, and said nothing at all.
  const written = res.ownedTiles ?? 0;
  const verified = res.verifiedTiles ?? 0;
  if (written === 0 || verified < written) {
    throw new Error(
      `seed: wrote ${written} territory tiles (${res.blockedTiles ?? 0} blocked) but only ${verified}`
      + ' read back as owned — check the TileDoc shape',
    );
  }
  // The client caches the world payload for the session; a reload is the cheapest way to make the
  // seeded state the one the sweep's SLG stops actually render.
  await page.reload();
}
