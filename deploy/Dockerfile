FROM oven/bun:1-alpine
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]

# Coolify/Traefik can use this; also a plain container healthcheck.
HEALTHCHECK --interval=60s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["bun", "run", "src/index.ts"]
