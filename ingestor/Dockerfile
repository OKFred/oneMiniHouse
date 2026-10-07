FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@11.5.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY src ./src
COPY test ./test
COPY scripts ./scripts
COPY sql ./sql
COPY config/ingestor.example.json config/cpu-core-alerts.example.json config/mqtt-telemetry-clients.example.json ./config/
COPY tsconfig.json ./
RUN pnpm check && pnpm test && pnpm prune --prod --ignore-scripts
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/sql ./sql
COPY LICENSE ./LICENSE
CMD ["node", "src/main.ts"]
