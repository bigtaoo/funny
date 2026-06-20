# 骨骼动画编辑器生产镜像：webpack 生产构建 → nginx 托管静态。
# 纯前端工具，不连后端；本地全栈里仅作为一个固定地址的静态站点（端口在 compose 映射）。
FROM node:20-alpine AS build
WORKDIR /app
# 弱网/慢镜像源下 npm ci 易 EIDLETIMEOUT；放宽超时 + 多次重试。
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
