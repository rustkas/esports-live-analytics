FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lockb* ./
COPY packages/shared/package.json packages/shared/
COPY services/ingestion/package.json services/ingestion/

RUN bun install --frozen-lockfile || bun install

# Build
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY packages/shared ./packages/shared
COPY services/ingestion ./services/ingestion
COPY tsconfig.base.json ./

WORKDIR /app/services/ingestion

# Runtime
FROM base AS runtime
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/ingestion ./services/ingestion

WORKDIR /app/services/ingestion

ENV NODE_ENV=production
EXPOSE 8081

CMD ["bun", "run", "src/index.ts"]
