# Notebook Wars server image (C-3 / S1-M).
# Single image hosts metaserver / gateway / matchsvc / gameserver / commercial / worldsvc / admin — all share @nw/shared, build once;
# compose uses `command` to select which process to run (node metaserver|gateway|matchsvc|gameserver|commercial|worldsvc|admin /dist/index.js).
#
# Multi-stage:
#   build   —— npm ci for entire workspace + tsc -b ten packages (including deterministic engine @nw/engine, required by worldsvc at runtime)
#   runtime —— only retains node_modules + per-package dist + contracts (meta reads openapi.yml; gateway/game reads transport.proto at runtime)

FROM node:20-alpine AS build
WORKDIR /app
# Copy manifests first to hit npm ci cache layer (source changes don't require reinstalling dependencies)
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY engine/package.json ./engine/
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
RUN npx tsc -b shared engine metaserver gateway matchsvc gameserver commercial worldsvc admin analyticsvc

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# node_modules/@nw/shared is a workspace symlink to ../shared → need to copy shared/dist as well.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/shared/dist ./shared/dist
# worldsvc requires('@nw/engine') at runtime (deterministic siege engine) → node_modules/@nw/engine is a workspace symlink to ../engine → need to copy engine/dist.
COPY --from=build /app/engine/package.json ./engine/package.json
COPY --from=build /app/engine/dist ./engine/dist
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
# meta reads contracts/openapi.yml; gateway/gameserver reads contracts/transport.proto at runtime (dist/*.js → /app/contracts).
COPY --from=build /app/contracts ./contracts
# Default: metaserver; gameserver overrides command in compose.
CMD ["node", "metaserver/dist/index.js"]
