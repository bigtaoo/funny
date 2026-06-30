# Ops admin frontend production image: webpack production build → nginx static hosting.
# The browser calls the admin backend cross-origin (default http://localhost:18083, configurable in the top input);
# admin has CORS open to all origins (OPS_DESIGN), so static hosting is sufficient.
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
