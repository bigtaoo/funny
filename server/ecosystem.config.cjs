// pm2 process orchestration (C-3 / S1-M / A9, non-Docker path).
// For running node directly on a VPS (mongod installed locally, caddy as a system service) instead of Docker:
//   cd server && npm ci && npx tsc -b shared engine metaserver gateway matchsvc gameserver commercial worldsvc admin analyticsvc socialsvc auctionsvc
//   NW_JWT_SECRET=... NW_INTERNAL_KEY=... pm2 start ecosystem.config.cjs && pm2 save
//
// metaserver is stateless and can run as multiple instances (cluster); gateway / matchsvc / gameserver each hold in-memory state and must run as a single instance.
// Secrets are inherited from the shell environment at pm2 startup (do not write production secrets into this file).
//
// Internal links (S1-M5, matchsvc as a separate process):
//   gateway → matchsvc commands: NW_MATCHSVC_INTERNAL_URL=http://127.0.0.1:8091
//   matchsvc → gateway push:     NW_GATEWAY_INTERNAL_URL=http://127.0.0.1:8090
//   gameserver → matchsvc register/heartbeat: NW_MATCHSVC_INTERNAL_URL=http://127.0.0.1:8091

const META_BASE = process.env.NW_META_BASE_URL || 'http://127.0.0.1:8080';
const GAME_PUBLIC_WS = process.env.NW_GAME_PUBLIC_WS_URL || 'ws://127.0.0.1:8081/ws';
const GW_INTERNAL = process.env.NW_GATEWAY_INTERNAL_URL || 'http://127.0.0.1:8090';
const MM_INTERNAL = process.env.NW_MATCHSVC_INTERNAL_URL || 'http://127.0.0.1:8091';
// commercial internal base URL (meta → commercial; not reachable by players, not exposed publicly, S5).
const COMM_INTERNAL = process.env.NW_COMMERCIAL_INTERNAL_URL || 'http://127.0.0.1:8092';
// socialsvc internal base URL (gateway/worldsvc → socialsvc fan-out/delegation, S6).
const SOCIAL_INTERNAL = process.env.NW_SOCIALSVC_INTERNAL_URL || 'http://127.0.0.1:8085';
// admin internal base URL (meta/matchsvc feature-flag polling + worldsvc SLG shop-price polling).
// ⚠ comm-audit-internal-2026-07-28: this was missing from EVERY pm2 app block, so under pm2 the
// flag caches and the SLG shop-price cache silently never started (compose files had it; pm2 didn't).
const ADMIN_INTERNAL = process.env.NW_ADMIN_INTERNAL_URL || 'http://127.0.0.1:8083';
// worldsvc / auctionsvc / analyticsvc internal base URLs (admin ops proxy targets).
const WORLD_INTERNAL = process.env.NW_WORLD_INTERNAL_URL || 'http://127.0.0.1:18084';
const AUCTION_INTERNAL = process.env.NW_AUCTION_INTERNAL_URL || 'http://127.0.0.1:18086';
const ANALYTICS_BASE = process.env.NW_ANALYTICS_BASE_URL || 'http://127.0.0.1:18085';

const common = {
  NW_JWT_SECRET: process.env.NW_JWT_SECRET, // must be provided by the environment in production
  NW_INTERNAL_KEY: process.env.NW_INTERNAL_KEY, // shared between services; must be provided by the environment in production
};
const metaShared = {
  ...common,
  NW_MONGO_URI: process.env.NW_MONGO_URI || 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
  NW_MONGO_DB: process.env.NW_MONGO_DB || 'notebook_wars',
};

module.exports = {
  apps: [
    {
      name: 'nw-meta',
      cwd: __dirname,
      script: 'metaserver/dist/index.js',
      exec_mode: 'fork', // change to 'cluster' + instances:N for horizontal scaling (stateless)
      instances: 1,
      env: {
        ...metaShared,
        NW_META_PORT: process.env.NW_META_PORT || '8080',
        NW_META_HOST: process.env.NW_META_HOST || '127.0.0.1',
        NW_WX_APPID: process.env.NW_WX_APPID || '',
        NW_WX_SECRET: process.env.NW_WX_SECRET || '',
        NW_COMMERCIAL_INTERNAL_URL: COMM_INTERNAL, // meta orchestrates economy calls to commercial
        NW_GATEWAY_INTERNAL_URL: GW_INTERNAL, // peer judge (Phase C): meta → gateway /gw/judge
        // Active-match resume tracking (login-reconnect-prompt, shared with matchsvc). Missing this
        // meant the resume prompt was silently dead in prod (matchsvc wrote the key, meta never read it).
        NW_REDIS_URL: process.env.NW_REDIS_URL || 'redis://127.0.0.1:6379',
        NW_ADMIN_INTERNAL_URL: ADMIN_INTERNAL, // feature-flag polling (was missing → flags always defaulted)
      },
    },
    {
      name: 'nw-commercial',
      cwd: __dirname,
      script: 'commercial/dist/index.js',
      exec_mode: 'fork', // single instance: authoritative wallet + dedicated database; scale horizontally via optimistic locking later, single instance for now
      instances: 1,
      env: {
        ...common,
        NW_COMM_PORT: process.env.NW_COMM_PORT || '8092',
        NW_COMM_HOST: process.env.NW_COMM_HOST || '127.0.0.1',
        // Dedicated database (defaults to the same Mongo instance as meta but a different database name, S5).
        NW_COMM_MONGO_URI:
          process.env.NW_COMM_MONGO_URI ||
          process.env.NW_MONGO_URI ||
          'mongodb://127.0.0.1:27017/?replicaSet=rs0',
        NW_COMM_MONGO_DB: process.env.NW_COMM_MONGO_DB || 'notebook_wars_commercial',
        // victoryDaily counter (2026-07-27, moved off Mongo — shared/src/dailyCounter.ts).
        NW_REDIS_URL: process.env.NW_REDIS_URL || 'redis://127.0.0.1:6379',
      },
    },
    {
      name: 'nw-gateway',
      cwd: __dirname,
      script: 'gateway/dist/index.js',
      exec_mode: 'fork', // single instance: account→socket connection affinity (multiple instances require Redis routing)
      instances: 1,
      env: {
        ...common,
        NW_GW_PORT: process.env.NW_GW_PORT || '8082',
        NW_GW_HOST: process.env.NW_GW_HOST || '127.0.0.1',
        NW_GW_INTERNAL_PORT: process.env.NW_GW_INTERNAL_PORT || '8090',
        NW_META_BASE_URL: META_BASE,
        NW_MATCHSVC_INTERNAL_URL: MM_INTERNAL,
        // Sect-channel real-time fan-out (S8-4b): subscribes to the same Redis as worldsvc.
        NW_GW_REDIS_URL: process.env.NW_GW_REDIS_URL || 'redis://127.0.0.1:6379',
        NW_SOCIALSVC_INTERNAL_URL: SOCIAL_INTERNAL,
      },
    },
    {
      name: 'nw-matchsvc',
      cwd: __dirname,
      script: 'matchsvc/dist/index.js',
      exec_mode: 'fork', // always single instance: room/matchmaking queue in-memory state (M17)
      instances: 1,
      env: {
        ...common,
        NW_MM_INTERNAL_PORT: process.env.NW_MM_INTERNAL_PORT || '8091',
        NW_MM_HOST: process.env.NW_MM_HOST || '127.0.0.1',
        NW_GATEWAY_INTERNAL_URL: GW_INTERNAL,
        NW_GAME_PUBLIC_WS_URL: GAME_PUBLIC_WS,
        // Active-match resume tracking + multi-instance gateway push fan-out (2026-07-18).
        NW_REDIS_URL: process.env.NW_REDIS_URL || 'redis://127.0.0.1:6379',
        NW_ADMIN_INTERNAL_URL: ADMIN_INTERNAL, // feature-flag polling (was missing → flags always defaulted)
      },
    },
    {
      name: 'nw-game',
      cwd: __dirname,
      script: 'gameserver/dist/index.js',
      exec_mode: 'fork', // must be single instance: room state lives in memory
      instances: 1,
      env: {
        ...common,
        NW_GAME_PORT: process.env.NW_GAME_PORT || '8081',
        NW_GAME_HOST: process.env.NW_GAME_HOST || '127.0.0.1',
        NW_META_BASE_URL: META_BASE,
        NW_MATCHSVC_INTERNAL_URL: MM_INTERNAL,
        NW_GAME_PUBLIC_WS_URL: GAME_PUBLIC_WS,
      },
    },
    {
      // SLG open world (S8, 7th process, 4th public REST face: /world /sect /nation; /family moved to socialsvc, /auction moved to auctionsvc).
      name: 'nw-world',
      cwd: __dirname,
      script: 'worldsvc/dist/index.js',
      exec_mode: 'fork', // single instance: march single-point scheduling + viewport push in-memory state (horizontal scaling requires Redis sharding; deferred)
      instances: 1,
      env: {
        ...common,
        NW_WORLD_PORT: process.env.NW_WORLD_PORT || '18084',
        NW_WORLD_HOST: process.env.NW_WORLD_HOST || '127.0.0.1',
        NW_WORLD_MONGO_URI:
          process.env.NW_WORLD_MONGO_URI ||
          process.env.NW_MONGO_URI ||
          'mongodb://127.0.0.1:27017/?replicaSet=rs0',
        NW_WORLD_MONGO_DB: process.env.NW_WORLD_MONGO_DB || 'notebook_wars_world',
        NW_WORLD_REDIS_URL: process.env.NW_WORLD_REDIS_URL || 'redis://127.0.0.1:6379',
        NW_GATEWAY_INTERNAL_URL: GW_INTERNAL, // real-time event push-back via /gw/push
        NW_SOCIALSVC_INTERNAL_URL: SOCIAL_INTERNAL,
        // ⚠ comm-audit-internal-2026-07-28: all three below were missing under pm2.
        // Without META: season mails/titles no-op, stronghold loot lost, setTeams throws INTERNAL.
        // Without COMMERCIAL: world chat / sect creation / relocation / shop / speedups all hard-fail.
        // Without ADMIN: SlgShopPriceCache never starts (ops price overrides inert).
        NW_META_INTERNAL_URL: META_BASE,
        NW_COMMERCIAL_INTERNAL_URL: COMM_INTERNAL,
        NW_ADMIN_INTERNAL_URL: ADMIN_INTERNAL,
      },
    },
    {
      // Ops admin backend (S7; not reachable by players; reverse-proxy does not route it; accessible only from internal network/VPN).
      name: 'nw-admin',
      cwd: __dirname,
      script: 'admin/dist/index.js',
      exec_mode: 'fork', // single instance: self-sampling timer + dedicated database
      instances: 1,
      env: {
        ...common,
        NW_ADMIN_PORT: process.env.NW_ADMIN_PORT || '8083',
        NW_ADMIN_HOST: process.env.NW_ADMIN_HOST || '127.0.0.1',
        NW_ADMIN_JWT_SECRET: process.env.NW_ADMIN_JWT_SECRET, // must be provided in production (isolated from player JWT)
        NW_ADMIN_MONGO_URI:
          process.env.NW_ADMIN_MONGO_URI ||
          process.env.NW_MONGO_URI ||
          'mongodb://127.0.0.1:27017/?replicaSet=rs0',
        NW_ADMIN_MONGO_DB: process.env.NW_ADMIN_MONGO_DB || 'notebook_wars_admin',
        NW_ADMIN_SEED_USER: process.env.NW_ADMIN_SEED_USER || '',
        NW_ADMIN_SEED_PASS: process.env.NW_ADMIN_SEED_PASS || '',
        NW_META_BASE_URL: META_BASE, // player.lookup / system mail endpoints
        NW_GATEWAY_INTERNAL_URL: GW_INTERNAL, // GET /internal/stats online count
        NW_MATCHSVC_INTERNAL_URL: MM_INTERNAL, // GET /internal/stats matchmaking pool
        // ⚠ comm-audit-internal-2026-07-28: compose files had these, pm2 didn't → the whole SLG
        // ops surface (season open/settle/reset, map templates, auction audit) threw "not configured".
        NW_WORLD_INTERNAL_URL: WORLD_INTERNAL,
        NW_AUCTION_INTERNAL_URL: AUCTION_INTERNAL,
        NW_ANALYTICS_BASE_URL: ANALYTICS_BASE,
      },
    },
    {
      // Social service (S6, 8th process, 5th public REST face: /social/*). Friends/chat/mail/family; connects to dedicated database nw_social.
      name: 'nw-social',
      cwd: __dirname,
      script: 'socialsvc/dist/index.js',
      exec_mode: 'fork', // single instance; horizontal scaling requires Redis sharding
      instances: 1,
      env: {
        ...common,
        NW_SOCIAL_PORT: process.env.NW_SOCIAL_PORT || '8085',
        NW_SOCIAL_HOST: process.env.NW_SOCIAL_HOST || '127.0.0.1',
        NW_SOCIAL_MONGO_URI:
          process.env.NW_SOCIAL_MONGO_URI ||
          process.env.NW_MONGO_URI ||
          'mongodb://127.0.0.1:27017/?replicaSet=rs0',
        NW_SOCIAL_MONGO_DB: process.env.NW_SOCIAL_MONGO_DB || 'nw_social',
        NW_GATEWAY_INTERNAL_URL: GW_INTERNAL,
        NW_META_INTERNAL_URL: META_BASE,
      },
    },
    {
      // Auction house (auction task5, AUCTION_DESIGN §9, 10th process, 6th public REST face: /auction/*).
      // Decoupled from worldId; dedicated database notebook_wars_auction; calls meta (item escrow) + commercial (coins).
      name: 'nw-auction',
      cwd: __dirname,
      script: 'auctionsvc/dist/index.js',
      exec_mode: 'fork', // single instance: expiry scheduler timer + dedicated database
      instances: 1,
      env: {
        ...common,
        NW_AUCTION_PORT: process.env.NW_AUCTION_PORT || '18086',
        NW_AUCTION_HOST: process.env.NW_AUCTION_HOST || '127.0.0.1',
        NW_AUCTION_MONGO_URI:
          process.env.NW_AUCTION_MONGO_URI ||
          process.env.NW_MONGO_URI ||
          'mongodb://127.0.0.1:27017/?replicaSet=rs0',
        NW_AUCTION_MONGO_DB: process.env.NW_AUCTION_MONGO_DB || 'notebook_wars_auction',
        NW_META_INTERNAL_URL: META_BASE, // material/equipment/card/skin escrow-grant + system mail
        NW_COMMERCIAL_INTERNAL_URL: COMM_INTERNAL, // deduct buyer coins / pay seller
      },
    },
    {
      // Analytics event ingestion service (A9, 9th process; not reachable by players; reverse-proxy does not route it).
      name: 'nw-analytics',
      cwd: __dirname,
      script: 'analyticsvc/dist/index.js',
      exec_mode: 'fork', // stateless, horizontally scalable (insertMany is idempotent)
      instances: 1,
      env: {
        ...common,
        NW_ANALYTICS_PORT: process.env.NW_ANALYTICS_PORT || '18085',
        NW_ANALYTICS_HOST: process.env.NW_ANALYTICS_HOST || '127.0.0.1',
        NW_ANALYTICS_MONGO_URI:
          process.env.NW_ANALYTICS_MONGO_URI ||
          process.env.NW_MONGO_URI ||
          'mongodb://127.0.0.1:27017/?replicaSet=rs0',
        NW_ANALYTICS_MONGO_DB: process.env.NW_ANALYTICS_MONGO_DB || 'notebook_wars_analytics',
      },
    },
  ],
};
