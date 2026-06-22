# 客户端生产镜像（本地「真实发布」模拟）：webpack 生产构建 → nginx 托管静态 + 反代后端。
# 单容器既是 SPA 主机又是反向代理：所有请求（静态 / REST / 控制面 WS / 数据面 WS）都经 nginx。
#
# 关键：构建上下文必须是「仓库根目录」（compose 里 context: .），因为 webpack 通过 @nw/engine
# alias 引用 server/engine/src（确定性引擎核心，见 SLG_DESIGN §16.7），需把 server/engine 一并拷进镜像。
# 同源部署地址（如需换 host/port，传 --build-arg 并保证与 nginx 暴露端口一致）。
# gateway 地址由 meta 鉴权回包下发、game 地址由 ticket 下发，故 NW_GATEWAY_WS 仅作 fallback。

FROM node:20-alpine AS build
WORKDIR /app/client
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000
COPY client/package.json client/package-lock.json ./
RUN npm ci
# @nw/engine alias 解析路径：../server/engine/src（相对于 WORKDIR /app/client）
COPY server/engine /app/server/engine
COPY client/ ./
ARG NW_API_BASE=http://localhost/api
ARG NW_GATEWAY_WS=ws://localhost/gw
ENV NW_API_BASE=$NW_API_BASE
ENV NW_GATEWAY_WS=$NW_GATEWAY_WS
RUN npm run build:web

FROM nginx:alpine AS runtime
COPY --from=build /app/client/dist /usr/share/nginx/html
COPY --from=build /app/client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
