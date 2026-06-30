# Level editor production image: webpack production build → nginx static hosting.
# NOTE: The build context must be the repo root (compose: context: .) because the editor references
# game-side data sources directly via the webpack `@game` alias
# (../../client/src/game — see tools/level-editor/DESIGN.md §6.5).
# So client/src must be copied into the image alongside the editor source for the alias to resolve.
FROM node:20-alpine AS build
WORKDIR /app/tools/level-editor
# On slow/flaky registries npm ci can hit EIDLETIMEOUT; raise timeout and retry count.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000
COPY tools/level-editor/package.json tools/level-editor/package-lock.json ./
RUN npm ci
# Single source of truth: game-side LevelDefinition / parseLevelDefinition / board constants (@game → ../../client/src/game).
# The re-export shim inside @game depends on @nw/engine, so that must be copied in too.
COPY server/engine /app/server/engine
COPY client/src /app/client/src
COPY tools/level-editor /app/tools/level-editor
RUN npm run build

FROM nginx:alpine AS runtime
COPY --from=build /app/tools/level-editor/dist /usr/share/nginx/html
EXPOSE 80
