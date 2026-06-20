# 关卡编辑器生产镜像：webpack 生产构建 → nginx 托管静态。
# 注意：构建上下文必须是「仓库根目录」(compose 里 context: .)，因为编辑器通过 webpack
# `@game` alias 直接引用游戏侧纯数据源（../../client/src/game，见 tools/level-editor/DESIGN.md §6.5）。
# 故除自身源码外，还需把 client/src 一并拷进镜像，alias 才能解析。
FROM node:20-alpine AS build
WORKDIR /app/tools/level-editor
# 弱网/慢镜像源下 npm ci 易 EIDLETIMEOUT；放宽超时 + 多次重试。
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000
COPY tools/level-editor/package.json tools/level-editor/package-lock.json ./
RUN npm ci
# 数据单一来源：游戏侧 LevelDefinition / parseLevelDefinition / 棋盘常量（@game → ../../client/src/game）。
COPY client/src /app/client/src
COPY tools/level-editor /app/tools/level-editor
RUN npm run build

FROM nginx:alpine AS runtime
COPY --from=build /app/tools/level-editor/dist /usr/share/nginx/html
EXPOSE 80
