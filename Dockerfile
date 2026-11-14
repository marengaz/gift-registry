FROM node:26.13.0-bookworm-slim AS build
ARG APP_VERSION=0.0.0-dev
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm version "$APP_VERSION" --no-git-tag-version --ignore-scripts --allow-same-version && npm ci && npm run build && npm prune --omit=dev --ignore-scripts

FROM node:26.13.0-bookworm-slim AS runtime
ARG APP_VERSION=0.0.0-dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/marengaz/gift-registry" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 BODY_SIZE_LIMIT=64M PROTOCOL_HEADER=x-forwarded-proto DATABASE_PATH=/data/gifts.sqlite MEDIA_PATH=/data/media
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/LICENSE ./LICENSE
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/build-worker ./build-worker
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/scripts ./scripts
RUN mkdir -p /data/media && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node", "build/index.js"]
