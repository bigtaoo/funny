// auctionsvc MongoDB (auction task 4): auctions / auctionDaily / auctionPrices collections.
// Dedicated database notebook_wars_auction, physically isolated from meta/commercial/world.
// Migrated from server/worldsvc/src/db.ts — all documents drop the worldId field (AUCTION_DESIGN §9,
// auction is an account-scoped, server-wide market, not tied to any SLG world/shard).
import { MongoClient, type Collection, type Db, type MongoClientOptions } from 'mongodb';
import type { AuctionStatus } from '@nw/shared';

export interface AuctionDoc {
  _id: string; // auctionId
  sellerId: string;
  itemType: string;
  item: Record<string, unknown>;
  qty: number;
  price: number; // fixed-price: unit transaction price; auction: kept in sync with topBid.amount by placeBid (falls back to startPrice pre-bid) so browse sort reflects the current effective price
  currency: string;
  designatedBuyerId?: string;
  expireAt: number; // ms (expiry settled by scanner: refund seller escrow / finalize auction bid; not TTL auto-delete, see ensureIndexes note)
  status: AuctionStatus;
  buyerId?: string;
  /** Transaction timestamp ms (written when status→sold). Anomaly auditing (D/G7) windows by this; legacy documents fall back to parsing listing ts from _id. */
  soldAt?: number;
  /** Terminal-transition timestamp ms (written when status leaves 'open': sold/cancelled/expired). Retention purge of closed My-Listings history windows by this; legacy closed docs without it fall back to expireAt. */
  closedAt?: number;
  // ── B Auction bidding (AUCTION_DESIGN §4.B). saleMode defaults to 'fixed' (backward-compatible with existing fixed-price listings) ──
  saleMode?: 'fixed' | 'auction';
  startPrice?: number;   // auction starting unit price
  buyoutPrice?: number;  // auction buyout unit price (optional)
  topBid?: { bidderId: string; amount: number; ts: number }; // current highest bid (unit price, coins already escrowed)
  /**
   * Ms at which this listing's cross-service settlement finished (journal row reached `done`). Written for
   * every terminal transition; its ABSENCE on a non-`open` listing is what the journal sweep's repair pass
   * scans for, so it must never be written before the goods/coins have actually been handed over.
   */
  settledAt?: number;
  rev: number;
}

/** C Daily quota counter (AUCTION_DESIGN §4.C). _id = `${accountId}:${dayKey}`, TTL auto-cleared. */
export interface AuctionDailyDoc {
  _id: string;
  accountId: string;
  dayKey: string; // server UTC day boundary YYYY-MM-DD
  lists: number;  // new listings created today
  buys: number;   // purchases / bids placed today
  expiresAt: Date; // BSON Date, TTL anchor field
}

/** G Price guardrail sliding window (AUCTION_DESIGN §4.G). _id = category, stores the last N transaction unit prices. */
export interface AuctionPriceDoc {
  _id: string;
  category: string; // material category (material:scrap…); equipment category equip:{defId}:{level}
  prices: number[]; // last N transaction unit prices (newest at tail, length ≤ AUCTION_PRICE_WINDOW_N)
}

/**
 * One account's participation in one auction listing ("My Bids" history, 2026-08-27).
 *
 * Why a separate collection rather than a `bidders` array on `AuctionDoc`: the listing document is the
 * hot doc every bid CASes on (`rev` guard), and an unbounded array on it would grow the very document
 * whose size and contention decide how fast bidding goes. Keeping participation out of it also means a
 * history read never touches the bidding write path.
 *
 * Why it exists at all: `AuctionDoc.topBid` only ever remembers the CURRENT leader, so the moment a
 * bidder is outbid the listing keeps no trace that they ever bid. "My Bids" derived from `topBid` alone
 * therefore silently dropped every listing the player was losing — the one case they most need to see.
 *
 * `_id` is `${auctionId}|${bidderId}`: one row per (listing, bidder) pair, upserted on every bid, so a
 * bidder who raises their own bid five times still occupies one row and `amount` is always their best.
 */
export interface AuctionBidDoc {
  _id: string; // `${auctionId}|${bidderId}`
  auctionId: string;
  bidderId: string;
  /** Highest unit price this account has bid on this listing (their own best, not the listing's). */
  amount: number;
  /** Coins escrowed by that bid (amount × qty at the time it was placed). */
  total: number;
  /** How many bids this account has placed on this listing. */
  bids: number;
  /** Ms of this account's latest bid on this listing. */
  ts: number;
  /**
   * TTL anchor. Set to the listing's expiry + AUCTION_CLOSED_RETENTION_SEC — deliberately anchored to the
   * LISTING's lifetime, not the bid's: anchoring it to the bid would let the row expire up to a full
   * listing duration before `purgeClosedListings` drops the listing itself, blanking rows out of My Bids
   * while the same trade is still visible in the seller's My Listings.
   */
  purgeAt: Date;
}

// ── Cross-service settlement journal (U13 close-out, 2026-08-24) ──────────────────────────────────
//
// Why a journal and not a transaction: an auction settlement moves assets in THREE processes and FOUR
// databases — coins in commercial (`notebook_wars_commercial`, HTTP /internal/spend), the listing state
// here (`notebook_wars_auction`), and the item + seller proceeds in meta (`notebook_wars`, HTTP system
// mail). A Mongo multi-document transaction spans one client/session, so it could only ever wrap
// `auctions` + `auctionDaily` + `auctionPrices` — none of which hold the money or the goods. What the
// flows actually need is not one atomic write but a DURABLE TO-DO LIST that survives a crash and can be
// re-driven, which is exactly what commercial's own `orders` collection already does for shop purchases
// (insert-first key claim → status → stale-claim CAS resume, see commercial/src/service/base.ts).
//
// The trick that makes this cheap: every downstream call is ALREADY idempotent by its own key
// (commercial dedupes on `orderId` and binds it to the first account that used it; meta system mail
// dedupes on `dispatchKey`). So this collection does not have to implement distributed atomicity — it
// only has to remember what is still owed and to whom.

/** Flow kinds. One journal row per flow instance; `_id` is the flow key (see journal.ts `flowKey`). */
export type AuctionOrderKind = 'list' | 'buy' | 'bid' | 'settle' | 'cancel' | 'expire';

/** Everything `deliverItem`/`meta.grant*` needs to hand an item over, snapshotted so a resumer never re-reads a mutable doc. */
export interface AuctionItemSnapshot {
  itemType: string;
  item: Record<string, unknown>;
  qty: number;
}

/**
 * One owed side effect. `name` is the progress key (`done[name]` = completion ts) and must be unique
 * within a journal row; `key` is the downstream idempotency key (commercial `orderId` / meta-mail
 * `dispatchKey`), always minted by journal.ts. Steps run in array order and a step already recorded in
 * `done` is skipped, which is what makes a resumed run identical to a first run.
 *
 * `requires` is only meaningful on a COMPENSATION step: it names the forward step that must actually have
 * landed for the compensation to apply. Without it a rollback would have to guess — refunding a bid whose
 * escrow never went through mints coins, and handing back an item that was never escrowed duplicates it.
 */
export type AuctionOrderStep =
  /** meta escrow (itemType-dispatched): removes the item from the seller and, for equipment/card/skin, reports back the instance snapshot. */
  | { name: string; key: string; requires?: string; op: 'escrow'; accountId: string; snapshot: AuctionItemSnapshot }
  /** meta grant: immediate re-grant straight into inventory (create-path rollback only — every other hand-over goes through mail). */
  | { name: string; key: string; requires?: string; op: 'grant'; accountId: string; snapshot: AuctionItemSnapshot }
  /** commercial coin debit. */
  | { name: string; key: string; requires?: string; op: 'spend'; accountId: string; amount: number; clientPlatform?: string }
  /** System-mail item delivery (escrow-out: the recipient claims the attachment). */
  | { name: string; key: string; requires?: string; op: 'mailItem'; accountId: string; snapshot: AuctionItemSnapshot; reason: 'sold' | 'returned' }
  /** System-mail coin delivery (seller proceeds / escrow refund). */
  | { name: string; key: string; requires?: string; op: 'mailCoins'; accountId: string; amount: number; reason: 'proceeds' | 'refund' }
  /**
   * Local: release a listing this flow claimed (sold→open). Guarded on
   * `{status:'sold', buyerId:<this buyer>, settledAt absent}` rather than on a `rev` captured at claim
   * time, precisely so the step can be baked into the plan BEFORE the claim runs — otherwise a crash
   * between the claim and "record how to undo it" would leave a listing sold to a buyer who was never
   * charged and can never be released. That triple identifies exactly our own unsettled claim: only one
   * caller can win open→sold, a retry by the same buyer reuses this same journal row, and a completed
   * flow has `settledAt` set, which makes the compensation a no-op.
   */
  | { name: string; key: string; requires?: string; op: 'unclaim'; auctionId: string; buyerId: string };

/**
 * Durable intent + progress for one cross-service auction flow.
 *
 * Central invariant: **`aborted` means every charge this row made has been refunded.** A reopen therefore
 * always advances `cycle`, which re-keys every downstream call — without that, a retry of a bid whose
 * escrow was already refunded would replay the original `orderId`, commercial would dedupe it as
 * already-charged, and the bidder would get a bid with no money behind it.
 */
export interface AuctionOrderDoc {
  _id: string; // flow key — always carries the acting account (journal.ts `flowKey`; never hand-built, enforced by check:auctionjournal)
  auctionId: string;
  kind: AuctionOrderKind;
  /** The account whose assets this flow moves (buyer/bidder/seller). Guards a replay against a colliding key. */
  actorId: string;
  status: 'pending' | 'done' | 'aborted';
  /** Owed side effects, append-only (`$push`) so a concurrent resumer can never truncate another's additions. */
  steps: AuctionOrderStep[];
  /**
   * How many leading `steps` entries run BEFORE the flow's branch point (`list` escrows first, `bid`
   * escrows the coins first; `buy` has none, because its branch is a local claim). This bound is what
   * keeps a resumer honest: a row still sitting at `decided:false` can only ever have started these
   * steps, so the resumer knows exactly which side effects might be in flight — and, just as importantly,
   * that it must NOT run the rest. Charging a buyer whose request died minutes ago, for a listing they
   * were never told they got, is precisely the outcome `prefix: 0` on the buy flow forbids.
   */
  prefix: number;
  /** step name → completion ms. Written with point-path `$set` only: a delta write, never a snapshot-derived absolute. */
  done: Record<string, number>;
  /**
   * step name → the ms at which a PRE-BRANCH step was first attempted, written before the call goes out.
   * A rollback needs this to tell "never tried" from "tried, outcome unknown": the first must be left
   * alone, the second must be retried to a definitive answer before anything is undone. Without the
   * distinction a rollback would fire the pre-branch call itself — charging a bidder purely so it could
   * mail the coins straight back.
   */
  started: Record<string, number>;
  /**
   * Did the request path get past its branch point (the local CAS that decides whether the flow proceeds)?
   * False means the process died before deciding, so a resumer must run `undecided` instead of `steps`.
   * Claim-first flows (settle/cancel/expire) branch BEFORE the journal exists and so start `true`.
   */
  decided: boolean;
  /**
   * What to run when the flow cannot go forward — either a resumer found `decided:false` (the process
   * died before the branch) or a surfacing step failed. Release the claim, hand the escrow back, refund
   * the escrowed bid.
   */
  compensation: AuctionOrderStep[];
  /** Escrow result recorded by the `escrow` step — the instance snapshot create.ts stores in the listing. */
  escrowed?: AuctionItemSnapshot;
  /** Bumped on every reopen of an aborted row; suffixes the downstream idempotency keys so a genuine retry is a genuine new charge (journal.ts `stepKey`). */
  cycle: number;
  /** Stale-claim CAS anchor (mirrors commercial's `healClaimedAt`): only the resumer whose CAS matches may drive this row. */
  claimedAt: number;
  /** Resume attempts, for exponential backoff and for making a permanently-stuck debt visible in logs. */
  attempts: number;
  /** Earliest ms at which a resumer may pick this row up again (backoff). */
  nextAttemptAt: number;
  ts: number;
  /** TTL anchor, set only when the row goes terminal — a pending row is an unpaid debt and must never expire. */
  purgeAt?: Date;
}

export interface AuctionCollections {
  auctions: Collection<AuctionDoc>;
  auctionDaily: Collection<AuctionDailyDoc>;
  auctionPrices: Collection<AuctionPriceDoc>;
  auctionOrders: Collection<AuctionOrderDoc>;
  auctionBids: Collection<AuctionBidDoc>;
}

export interface AuctionMongo {
  client: MongoClient;
  db: Db;
  collections: AuctionCollections;
  ensureIndexes(): Promise<void>;
  runMigrations(): Promise<void>;
  close(): Promise<void>;
}

export async function createAuctionMongo(
  uri: string,
  dbName: string,
  options?: MongoClientOptions,
): Promise<AuctionMongo> {
  let client: MongoClient;
  try {
    client = new MongoClient(uri, options);
    await client.connect();
  } catch (e) {
    const redacted = uri.replace(/:\/\/[^@]*@/, '://***@');
    console.error(`[auctionsvc] MongoDB connection failed uri=${redacted} db=${dbName}`, e);
    throw e;
  }

  const db = client.db(dbName);
  const collections: AuctionCollections = {
    auctions: db.collection<AuctionDoc>('auctions'),
    auctionDaily: db.collection<AuctionDailyDoc>('auctionDaily'),
    auctionPrices: db.collection<AuctionPriceDoc>('auctionPrices'),
    auctionOrders: db.collection<AuctionOrderDoc>('auctionOrders'),
    auctionBids: db.collection<AuctionBidDoc>('auctionBids'),
  };

  async function ensureIndexes(): Promise<void> {
    await collections.auctions.createIndex({ itemType: 1, status: 1 });
    await collections.auctions.createIndex({ sellerId: 1 });
    await collections.auctions.createIndex({ designatedBuyerId: 1 });
    // Note: auctions.expireAt is intentionally NOT a TTL index — expiry requires settlement (refund seller escrow); handled by the scanner using this index;
    // TTL auto-delete would discard escrowed goods before settlement.
    await collections.auctions.createIndex({ expireAt: 1 });
    // C Daily quota: TTL auto-cleared (expiresAt is BSON Date; Mongo TTL only works on Date).
    await collections.auctionDaily.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // listAuctions (browse) was a COLLSCAN + blocking in-memory sort on `price` — neither {itemType,status}
    // nor any other existing index has `status` as a usable prefix for the {status,price} sort. These two
    // cover both real query shapes: category-filtered browse (itemType given) and "all" browse (itemType
    // omitted). {status,itemType,price} also gives `status`-only queries (scanAnomalies) an index prefix,
    // turning that COLLSCAN into an index scan too. Found 2026-07-27 in a full Mongo/Redis read-path audit.
    await collections.auctions.createIndex({ status: 1, itemType: 1, price: 1 });
    await collections.auctions.createIndex({ status: 1, price: 1 });
    // purgeClosedListings runs hourly and filters/sorts by closedAt with no supporting index (COLLSCAN);
    // low urgency (scheduled, not request-path) but cheap to fix alongside the above.
    await collections.auctions.createIndex({ closedAt: 1 });
    // scanAnomalies (anti-RMT audit) sorts by soldAt desc before its 5000-doc cap (2026-07-29 audit fix) —
    // without this index that sort would be an in-memory COLLSCAN+sort over every sold doc ever recorded.
    await collections.auctions.createIndex({ status: 1, soldAt: -1 });
    // Settlement journal. The sweep's two queries: pending rows due for a retry, and terminal listings
    // whose delivery never completed (`settledAt` absent — see runMigrations for why legacy docs are stamped).
    await collections.auctionOrders.createIndex({ status: 1, nextAttemptAt: 1 });
    await collections.auctionOrders.createIndex({ auctionId: 1 });
    // TTL on `purgeAt`, which is written ONLY when a row goes terminal — a pending row is an unpaid debt
    // and must outlive every retention window until it is settled.
    await collections.auctionOrders.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
    await collections.auctions.createIndex({ status: 1, settledAt: 1 });
    // My Bids: the only query shape is "this bidder's rows, newest first" (getMyBids), then a
    // batched _id lookup of the listings themselves.
    await collections.auctionBids.createIndex({ bidderId: 1, ts: -1 });
    // TTL: unlike auctionOrders' purgeAt, this one is written on every upsert — a bid row owes nobody
    // anything, it is pure history, so letting it expire on schedule is correct.
    await collections.auctionBids.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
  }

  /**
   * Boot-time migration (runs before the HTTP server accepts traffic and before the scheduler starts, so
   * there are no concurrent writers — same posture as worldsvc's `runMigrations`).
   *
   * Stamps `settledAt` on every listing that is ALREADY in a terminal state. Those closed under the
   * pre-journal code either delivered their mail or silently lost it, and nothing in the data can tell
   * which; re-driving them would re-send every attachment under the journal's (buyer-scoped) dispatch
   * keys, which meta would treat as new mail — turning an unfixable old loss into a fresh duplication.
   * So they are declared settled and the sweep's repair pass only ever sees flows created by this code.
   */
  async function runMigrations(): Promise<void> {
    const res = await collections.auctions.updateMany(
      { status: { $ne: 'open' }, settledAt: { $exists: false } },
      [{ $set: { settledAt: { $ifNull: ['$closedAt', '$expireAt'] } } }],
    );
    if (res.modifiedCount > 0) {
      console.log(`[auctionsvc] migration: stamped settledAt on ${res.modifiedCount} pre-journal closed listing(s)`);
    }
  }

  return {
    client,
    db,
    collections,
    ensureIndexes,
    runMigrations,
    close: () => client.close(),
  };
}
