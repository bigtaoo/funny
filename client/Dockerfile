# 客户端生产镜像（本地「真实发布」模拟）：webpack 生产构建 → nginx 托管静态 + 反代后端。
# 单容器既是 SPA 主机又是反向代理：所有请求（静态 / REST / 控制面 WS / 数据面 WS）都经 nginx。
#
# 关键：客户端生产构建默认 NW_API_BASE='' → net/config.getApiBaseUrl 返回 null → 纯离线。
# 因此必须在构建期注入同源地址（默认 http://localhost/api），运行时 fetch / WS 才会发出。
# gateway 地址由 meta 鉴权回包下发、game 地址由 ticket 下发，故 NW_GATEWAY_WS 仅作 fallback。

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 同源部署地址（如需换 host/port，传 --build-arg 并保证与 nginx 暴露端口一致）。
ARG NW_API_BASE=http://localhost/api
ARG NW_GATEWAY_WS=ws://localhost/gw
ENV NW_API_BASE=$NW_API_BASE
ENV NW_GATEWAY_WS=$NW_GATEWAY_WS
RUN npm run build:web

FROM nginx:alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
