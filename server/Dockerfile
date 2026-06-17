# Notebook Wars 服务端镜像（C-3 / S1-M）。
# 单一镜像同时承载 metaserver / gateway / matchsvc / gameserver / commercial / worldsvc / admin——共享 @nw/shared，build 一次即可；
# compose 用 `command` 选择跑哪个进程（node metaserver|gateway|matchsvc|gameserver|commercial|worldsvc|admin /dist/index.js）。
#
# 多阶段：
#   build   —— npm ci 整个 workspace + tsc -b 八包
#   runtime —— 只保留 node_modules + 各包 dist + contracts（meta 读 openapi.yml；gateway/game 运行期读 transport.proto）

FROM node:20-alpine AS build
WORKDIR /app
# 先拷 manifest 命中 npm ci 缓存层（源码变动不必重装依赖）
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY metaserver/package.json ./metaserver/
COPY gateway/package.json ./gateway/
COPY matchsvc/package.json ./matchsvc/
COPY gameserver/package.json ./gameserver/
COPY commercial/package.json ./commercial/
COPY worldsvc/package.json ./worldsvc/
COPY admin/package.json ./admin/
COPY analyticsvc/package.json ./analyticsvc/
RUN npm ci
COPY . .
RUN npx tsc -b shared metaserver gateway matchsvc gameserver commercial worldsvc admin analyticsvc

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
COPY --from=build /app/matchsvc/package.json ./matchsvc/package.json
COPY --from=build /app/matchsvc/dist ./matchsvc/dist
COPY --from=build /app/gameserver/package.json ./gameserver/package.json
COPY --from=build /app/gameserver/dist ./gameserver/dist
COPY --from=build /app/commercial/package.json ./commercial/package.json
COPY --from=build /app/commercial/dist ./commercial/dist
COPY --from=build /app/worldsvc/package.json ./worldsvc/package.json
COPY --from=build /app/worldsvc/dist ./worldsvc/dist
COPY --from=build /app/admin/package.json ./admin/package.json
COPY --from=build /app/admin/dist ./admin/dist
COPY --from=build /app/analyticsvc/package.json ./analyticsvc/package.json
COPY --from=build /app/analyticsvc/dist ./analyticsvc/dist
# meta 读 contracts/openapi.yml；gateway/gameserver 运行期读 contracts/transport.proto（dist/*.js → /app/contracts）。
COPY --from=build /app/contracts ./contracts
# 默认 metaserver；gameserver 服务在 compose 里覆盖 command。
CMD ["node", "metaserver/dist/index.js"]
