// Single source of truth: which service owns which Mongo database, under which login.
//
// COMMERCIAL_DESIGN §0 K1/K4 has said since 2026-06-14 that real-money data is PHYSICALLY isolated —
// commercial owns `notebook_wars_commercial` and nothing else may touch it. Until 2026-09-12 that was a
// convention: every service was handed the same `NW_MONGO_URI`, i.e. the same Mongo login, whose grants
// covered every database on the cluster. One line of `client.db('notebook_wars_commercial')` in any
// service would have worked, and no layer below the code review would have objected.
//
// This table turns the convention into a credential boundary. Each service authenticates as its own user,
// created with `readWrite` on ITS OWN database and nothing else, so reaching for another service's data
// fails at the driver with an authorization error rather than succeeding quietly.
//
// Consumed by:
//   · scripts/provisionMongoUsers.mjs — creates/updates these users on a cluster (Atlas or a container).
//   · scripts/checkDbIsolation.mjs    — CI gate: no service's code or compose block may carry another's.
//
// Adding a service that connects to Mongo means adding a row here; the gate fails on a compose block
// holding a `NW_*_MONGO_URI` that no row claims, which is what stops a new service from quietly
// inheriting the shared credential.

/**
 * @typedef {object} MongoServiceRow
 * @property {string} service   Compose service name / workspace directory under server/.
 * @property {string} user      Mongo username provisioned for it.
 * @property {string} db        Database it owns. Also its authSource: the user is created IN this db.
 * @property {string} dbDefault Default database name baked into the service's config.ts.
 * @property {string} uriEnv    Env var carrying its connection string.
 * @property {string} dbEnv     Env var carrying its database name.
 */

/** @type {MongoServiceRow[]} */
export const MONGO_SERVICES = [
  // metaserver reads NW_MONGO_URI / NW_MONGO_DB — the base pair in @nw/shared's loadServerEnv. Every other
  // service also *loads* that pair (it is part of ServerEnv) but connects with its own; the compose blocks
  // therefore hand NW_MONGO_URI to metaserver alone, so no other container even holds meta's credential.
  {
    service: 'metaserver',
    user: 'nw_meta',
    db: 'notebook_wars',
    dbDefault: 'notebook_wars',
    uriEnv: 'NW_MONGO_URI',
    dbEnv: 'NW_MONGO_DB',
  },
  {
    service: 'commercial',
    user: 'nw_commercial',
    db: 'notebook_wars_commercial',
    dbDefault: 'notebook_wars_commercial',
    uriEnv: 'NW_COMM_MONGO_URI',
    dbEnv: 'NW_COMM_MONGO_DB',
  },
  {
    service: 'worldsvc',
    user: 'nw_world',
    db: 'notebook_wars_world',
    dbDefault: 'notebook_wars_world',
    uriEnv: 'NW_WORLD_MONGO_URI',
    dbEnv: 'NW_WORLD_MONGO_DB',
  },
  {
    service: 'socialsvc',
    user: 'nw_social',
    db: 'nw_social',
    dbDefault: 'nw_social',
    uriEnv: 'NW_SOCIAL_MONGO_URI',
    dbEnv: 'NW_SOCIAL_MONGO_DB',
  },
  {
    service: 'auctionsvc',
    user: 'nw_auction',
    db: 'notebook_wars_auction',
    dbDefault: 'notebook_wars_auction',
    uriEnv: 'NW_AUCTION_MONGO_URI',
    dbEnv: 'NW_AUCTION_MONGO_DB',
  },
  {
    service: 'analyticsvc',
    user: 'nw_analytics',
    db: 'notebook_wars_analytics',
    dbDefault: 'notebook_wars_analytics',
    uriEnv: 'NW_ANALYTICS_MONGO_URI',
    dbEnv: 'NW_ANALYTICS_MONGO_DB',
  },
  {
    service: 'admin',
    user: 'nw_admin',
    db: 'notebook_wars_admin',
    dbDefault: 'notebook_wars_admin',
    uriEnv: 'NW_ADMIN_MONGO_URI',
    dbEnv: 'NW_ADMIN_MONGO_DB',
  },
];

/** Services that talk to Mongo at all. gateway / matchsvc / gameserver / botsvc hold no database login by design. */
export const MONGO_SERVICE_NAMES = MONGO_SERVICES.map((r) => r.service);

/** Every `NW_*_MONGO_URI` this repo knows about — anything else in a compose block is unclaimed and suspect. */
export const ALL_URI_ENVS = MONGO_SERVICES.map((r) => r.uriEnv);

/** @param {string} service @returns {MongoServiceRow | undefined} */
export function rowForService(service) {
  return MONGO_SERVICES.find((r) => r.service === service);
}

/**
 * Local-stack passwords. The local Mongo is not published to the host (cluster-internal only, see the
 * compose file), so these are deliberately fixed and readable: the point of local auth is to make a
 * misgranted user FAIL LOCALLY, not to keep a secret from anyone who can already run `docker exec`.
 * Cloud passwords never come from here — provisionMongoUsers.mjs generates them.
 */
export function localPassword(user) {
  return `localdev-${user}`;
}

export const LOCAL_ROOT_USER = 'root';
export const LOCAL_ROOT_PASSWORD = 'localdev-root';
