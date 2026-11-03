FROM node:26.13.0-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev --ignore-scripts

FROM node:26.13.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 BODY_SIZE_LIMIT=64M PROTOCOL_HEADER=x-forwarded-proto DATABASE_PATH=/data/gifts.sqlite MEDIA_PATH=/data/media
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/build-worker ./build-worker
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/scripts ./scripts
RUN mkdir -p /data/media && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node", "build/index.js"]
