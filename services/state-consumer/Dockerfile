FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lockb* ./
COPY packages/shared/package.json packages/shared/
COPY services/state-consumer/package.json services/state-consumer/

RUN bun install --frozen-lockfile || bun install

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY packages/shared ./packages/shared
COPY services/state-consumer ./services/state-consumer
COPY tsconfig.base.json ./

WORKDIR /app/services/state-consumer

FROM base AS runtime
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/state-consumer ./services/state-consumer

WORKDIR /app/services/state-consumer

ENV NODE_ENV=production

CMD ["bun", "run", "src/index.ts"]
