# Skeleton animation editor production image: webpack production build → nginx static hosting.
# Pure frontend tool, no backend connection; runs as a fixed-address static site in the local full-stack (port mapped in compose).
FROM node:20-alpine AS build
WORKDIR /app
# On slow/flaky registries npm ci can hit EIDLETIMEOUT; raise timeout and retry count.
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
