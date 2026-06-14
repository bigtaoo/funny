// pm2 进程编排（C-3 / S1-M，非 Docker 路线）。
// 适用于直接在 VPS 上跑 node（mongod 本机装、caddy 系统服务），不想用 Docker 时：
//   cd server && npm ci && npx tsc -b shared metaserver gateway matchsvc gameserver commercial
//   NW_JWT_SECRET=... NW_INTERNAL_KEY=... pm2 start ecosystem.config.cjs && pm2 save
//
// metaserver 无状态可起多实例（cluster）；gateway / matchsvc / gameserver 各有内存状态必须单实例。
// 密钥从启动 pm2 时的 shell 环境继承（勿把生产密钥写进本文件）。
//
// 内部链路（S1-M5，matchsvc 独立进程）：
//   gateway → matchsvc 命令：NW_MATCHSVC_INTERNAL_URL=http://127.0.0.1:8091
//   matchsvc → gateway 推送：NW_GATEWAY_INTERNAL_URL=http://127.0.0.1:8090
//   gameserver → matchsvc 注册/心跳：NW_MATCHSVC_INTERNAL_URL=http://127.0.0.1:8091

const META_BASE = process.env.NW_META_BASE_URL || 'http://127.0.0.1:8080';
const GAME_PUBLIC_WS = process.env.NW_GAME_PUBLIC_WS_URL || 'ws://127.0.0.1:8081/ws';
const GW_INTERNAL = process.env.NW_GATEWAY_INTERNAL_URL || 'http://127.0.0.1:8090';
const MM_INTERNAL = process.env.NW_MATCHSVC_INTERNAL_URL || 'http://127.0.0.1:8091';
// commercial 内部基址（meta → commercial；玩家不可达，不暴露公网，S5）。
const COMM_INTERNAL = process.env.NW_COMMERCIAL_INTERNAL_URL || 'http://127.0.0.1:8092';

const common = {
  NW_JWT_SECRET: process.env.NW_JWT_SECRET, // 生产必须由环境提供
  NW_INTERNAL_KEY: process.env.NW_INTERNAL_KEY, // 服务间共用，生产必须由环境提供
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
      exec_mode: 'fork', // 横扩改 'cluster' + instances:N（无状态）
      instances: 1,
      env: {
        ...metaShared,
        NW_META_PORT: process.env.NW_META_PORT || '8080',
        NW_META_HOST: process.env.NW_META_HOST || '127.0.0.1',
        NW_WX_APPID: process.env.NW_WX_APPID || '',
        NW_WX_SECRET: process.env.NW_WX_SECRET || '',
        NW_COMMERCIAL_INTERNAL_URL: COMM_INTERNAL, // meta 编排经济调 commercial
      },
    },
    {
      name: 'nw-commercial',
      cwd: __dirname,
      script: 'commercial/dist/index.js',
      exec_mode: 'fork', // 单实例：钱包权威 + 专属库；横扩走库的乐观锁，但前期单实例
      instances: 1,
      env: {
        ...common,
        NW_COMM_PORT: process.env.NW_COMM_PORT || '8092',
        NW_COMM_HOST: process.env.NW_COMM_HOST || '127.0.0.1',
        // 专属库（默认复用 meta 同 Mongo 实例、不同库名，S5）。
        NW_COMM_MONGO_URI:
          process.env.NW_COMM_MONGO_URI ||
          process.env.NW_MONGO_URI ||
          'mongodb://127.0.0.1:27017/?replicaSet=rs0',
        NW_COMM_MONGO_DB: process.env.NW_COMM_MONGO_DB || 'notebook_wars_commercial',
      },
    },
    {
      name: 'nw-gateway',
      cwd: __dirname,
      script: 'gateway/dist/index.js',
      exec_mode: 'fork', // 单实例：account→socket 连接亲和（多实例需 Redis 路由）
      instances: 1,
      env: {
        ...common,
        NW_GW_PORT: process.env.NW_GW_PORT || '8082',
        NW_GW_HOST: process.env.NW_GW_HOST || '127.0.0.1',
        NW_GW_INTERNAL_PORT: process.env.NW_GW_INTERNAL_PORT || '8090',
        NW_META_BASE_URL: META_BASE,
        NW_MATCHSVC_INTERNAL_URL: MM_INTERNAL,
      },
    },
    {
      name: 'nw-matchsvc',
      cwd: __dirname,
      script: 'matchsvc/dist/index.js',
      exec_mode: 'fork', // 永远单实例：房间/匹配队列内存态（M17）
      instances: 1,
      env: {
        ...common,
        NW_MM_INTERNAL_PORT: process.env.NW_MM_INTERNAL_PORT || '8091',
        NW_MM_HOST: process.env.NW_MM_HOST || '127.0.0.1',
        NW_GATEWAY_INTERNAL_URL: GW_INTERNAL,
        NW_GAME_PUBLIC_WS_URL: GAME_PUBLIC_WS,
      },
    },
    {
      name: 'nw-game',
      cwd: __dirname,
      script: 'gameserver/dist/index.js',
      exec_mode: 'fork', // 必须单实例：房间状态在内存
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
  ],
};
