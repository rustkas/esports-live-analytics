FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lockb* ./
COPY packages/shared/package.json packages/shared/
COPY services/analytics/package.json services/analytics/

RUN bun install --frozen-lockfile || bun install

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY packages/shared ./packages/shared
COPY services/analytics ./services/analytics
COPY tsconfig.base.json ./

WORKDIR /app/services/analytics

FROM base AS runtime
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/analytics ./services/analytics

WORKDIR /app/services/analytics

ENV NODE_ENV=production
EXPOSE 8082

CMD ["bun", "run", "src/index.ts"]
