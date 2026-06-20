# 运维后台前端生产镜像：webpack 生产构建 → nginx 托管静态。
# 浏览器里跨源调用 admin 后端（默认 http://localhost:18083，可在页面顶部输入框改）；
# admin 已对所有源开放 CORS（OPS_DESIGN），故静态托管即可。
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
