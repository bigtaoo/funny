# Notebook Wars 服务端镜像（C-3 / S1-M）。
# 单一镜像同时承载 metaserver / gateway / gameserver——三者共享 @nw/shared，build 一次即可；
# compose 用 `command` 选择跑哪个进程（node metaserver|gateway|gameserver /dist/index.js）。
#
# 多阶段：
#   build   —— npm ci 整个 workspace + tsc -b 四包
#   runtime —— 只保留 node_modules + 各包 dist + contracts（meta 读 openapi.yml；gateway/game 运行期读 transport.proto）

FROM node:20-alpine AS build
WORKDIR /app
# 先拷 manifest 命中 npm ci 缓存层（源码变动不必重装依赖）
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY metaserver/package.json ./metaserver/
COPY gateway/package.json ./gateway/
COPY gameserver/package.json ./gameserver/
RUN npm ci
COPY . .
RUN npx tsc -b shared metaserver gateway gameserver

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# node_modules 内 @nw/shared 是指向 ../shared 的 workspace 符号链接 → 需同时拷 shared/dist。
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/metaserver/package.json ./metaserver/package.json
COPY --from=build /app/metaserver/dist ./metaserver/dist
COPY --from=build /app/gateway/package.json ./gateway/package.json
COPY --from=build /app/gateway/dist ./gateway/dist
COPY --from=build /app/gameserver/package.json ./gameserver/package.json
COPY --from=build /app/gameserver/dist ./gameserver/dist
# meta 读 contracts/openapi.yml；gateway/gameserver 运行期读 contracts/transport.proto（dist/*.js → /app/contracts）。
COPY --from=build /app/contracts ./contracts
# 默认 metaserver；gameserver 服务在 compose 里覆盖 command。
CMD ["node", "metaserver/dist/index.js"]
