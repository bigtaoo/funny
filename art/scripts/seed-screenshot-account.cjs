// Give a freshly registered account enough state that store screenshots show a lived-in save
// instead of a blank one: campaign progress + stars, a platinum ladder record, all six skins,
// materials, fate points.
//
// Coins are deliberately NOT seeded here — metaserver reconciles the wallet against commercial's
// ledger, so a hand-written save.wallet.coins gets zeroed at the next login. The capture script
// tops up through the dev IAP stub instead (the real grant path).
//
// Usage: node art/scripts/seed-screenshot-account.cjs <loginId>
// Prereq: the local dev Mongo from capture-store-screenshots.mjs's header (rs0 on 27017).

const { MongoClient } = require('../../server/node_modules/mongodb');

const loginId = process.argv[2];
if (!loginId) { console.error('usage: node seed-screenshot-account.cjs <loginId>'); process.exit(1); }

(async () => {
  const c = new MongoClient('mongodb://127.0.0.1:27017/?replicaSet=rs0');
  await c.connect();
  const db = c.db('notebook_wars');
  const acct = await db.collection('accounts').findOne({ 'password.loginId': loginId });
  if (!acct) { console.error('no account with loginId', loginId); process.exit(1); }

  const cleared = [];
  const stars = {};
  for (let ch = 1; ch <= 3; ch++) for (let lv = 1; lv <= 10; lv++) { const k = `ch${ch}_lv${lv}`; cleared.push(k); stars[k] = 3; }
  for (let lv = 1; lv <= 4; lv++) { const k = `ch4_lv${lv}`; cleared.push(k); stars[k] = lv < 4 ? 3 : 2; }

  const r = await db.collection('saves').updateOne({ _id: acct._id }, {
    $set: {
      'save.progress.cleared': cleared,
      'save.progress.stars': stars,
      'save.inventory.skins': ['skin_shop_c1', 'skin_shop_r1', 'skin_shop_e1', 'skin_e1', 'skin_e2', 'skin_l1'],
      'save.materials': { scrap: 340, lead: 82, binding: 17 },
      'save.pvp.elo': 1486, 'save.pvp.rank': 'platinum', 'save.pvp.wins': 63, 'save.pvp.losses': 31, 'save.pvp.streak': 4,
      'save.monetization.fatePoints': 120,
    },
    $inc: { rev: 1, 'save.rev': 1 },
  });
  console.log('seeded', r.modifiedCount, 'accountId', acct._id);
  await c.close();
})();
