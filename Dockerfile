# syntax=docker/dockerfile:1
# Single image: Express API + the built React frontend. Debian (slim), not alpine, so
# better-sqlite3's prebuilt native binary works without a compiler.

FROM node:22-slim AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-slim AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    FEED_READER_DATA_DIR=/data
WORKDIR /app
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/
COPY server/src ./server/src
# The server resolves the frontend as ../../web/dist from server/src.
COPY --from=web-build /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "server/src/index.js"]
