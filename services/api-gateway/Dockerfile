FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lockb* ./
COPY packages/shared/package.json packages/shared/
COPY services/api-gateway/package.json services/api-gateway/

RUN bun install --frozen-lockfile || bun install

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY packages/shared ./packages/shared
COPY services/api-gateway ./services/api-gateway
COPY tsconfig.base.json ./

WORKDIR /app/services/api-gateway

FROM base AS runtime
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/api-gateway ./services/api-gateway

WORKDIR /app/services/api-gateway

ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
