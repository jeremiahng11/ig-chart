FROM node:20.18-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20.18-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY mt5 ./mt5
RUN mkdir -p .data .cache && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server.js"]
