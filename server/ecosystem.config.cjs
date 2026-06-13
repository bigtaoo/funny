// pm2 进程编排（C-3，非 Docker 路线）。
// 适用于直接在 VPS 上跑 node（mongod 本机装、caddy 系统服务），不想用 Docker 时：
//   cd server && npm ci && npx tsc -b shared metaserver gameserver
//   NW_JWT_SECRET=... pm2 start ecosystem.config.cjs && pm2 save
//
// metaserver 无状态可起多实例（cluster）；gameserver 有房间状态必须单实例（房间亲和，§6.5）。
// 密钥从启动 pm2 时的 shell 环境继承（勿把生产密钥写进本文件）。

const shared = {
  NW_MONGO_URI: process.env.NW_MONGO_URI || 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
  NW_MONGO_DB: process.env.NW_MONGO_DB || 'notebook_wars',
  NW_JWT_SECRET: process.env.NW_JWT_SECRET, // 生产必须由环境提供
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
        ...shared,
        NW_META_PORT: process.env.NW_META_PORT || '8080',
        NW_META_HOST: process.env.NW_META_HOST || '127.0.0.1',
        NW_WX_APPID: process.env.NW_WX_APPID || '',
        NW_WX_SECRET: process.env.NW_WX_SECRET || '',
      },
    },
    {
      name: 'nw-game',
      cwd: __dirname,
      script: 'gameserver/dist/index.js',
      exec_mode: 'fork', // 必须单实例：房间状态在内存
      instances: 1,
      env: {
        ...shared,
        NW_GAME_PORT: process.env.NW_GAME_PORT || '8081',
        NW_GAME_HOST: process.env.NW_GAME_HOST || '127.0.0.1',
      },
    },
  ],
};
