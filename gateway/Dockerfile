FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@11.5.0
RUN apt-get update && apt-get install -y --no-install-recommends dbus-daemon && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts --no-optional
COPY src ./src
COPY test ./test
COPY config/gateway.example.json config/modbus.example.json config/temperature.device.example.json config/xiaomi.device.example.json ./config/
COPY tsconfig.json ./
RUN pnpm check && dbus-run-session -- env DBUS_TEST_REQUIRED=1 pnpm test && pnpm prune --prod --ignore-scripts --no-optional

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NOBLE_BINDINGS=dbus DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/bluez-proxy/bus
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src ./src
COPY LICENSE ./LICENSE
CMD ["node", "src/main.ts"]
