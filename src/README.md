# Legacy uni-app client

The original Vue 3 / uni-app client remains available alongside the independent
gateway and ingestor services. It is not a client for their MQTT protocol or a
replacement for Grafana. It reads a user-configured Modbus TCP endpoint on
platforms supporting `uni.createTCPSocket`; ordinary web browsers cannot open
raw TCP sockets.

## Local use

Use Node.js 22 or later and the pnpm version in the root `package.json`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
cp .env.example .env.local
pnpm dev:h5
pnpm build:h5
pnpm build:mp-weixin
```

The app starts disconnected. Configure a public HTTP API base URL and/or TCP
endpoint in `.env.local`, or save the TCP host and port in the app's **我的**
page. Device selectors initially contain synthetic address `01`; override each
category with `VITE_MODBUS_DEVICES_JSON` as illustrated in `.env.example`.
Never put credentials in `VITE_*` variables: the values become part of the app.
The old implicit `src/env.json` debug-login import has been removed.

`UNI_MP_APPID` is written only to the generated mini-program project config.
Open `dist/build/mp-weixin` in WeChat DevTools, then set any developer-specific
options in its private project config. The native canvas adapter and its BSD
license are included under `wxcomponents/ec-canvas`. The build copies ECharts
6.1.0 and its license/NOTICE from the locked dependency directly into the generated mini-program output.

H5 is generated in `dist/build/h5`; `VITE_BASE_PATH` controls deployment beneath
a subpath. No build automatically copies output to a remote host or share.
Deployment and live-device verification are separate operator actions.

## Dependency boundary

The DCloud packages use the coherent release already recorded in the previous
lockfile (`3.0.0-3080420230531001`) with Vue 3.2.47. Vite is on the final 4.x
patch line, and root dependencies are reproducible through `pnpm-lock.yaml`.
The conflicting npm lockfile is retired. Unused Gulp, server-fetch externalizer,
and automation dependencies were removed.

This legacy framework still has known dependency advisories, including in its
Vite/Vue/i18n dependencies. A coordinated framework upgrade and
WeChat/device regression are required before calling it security-maintained.
The development server binds to loopback by default. Check the current state
with `pnpm audit --registry=https://registry.npmjs.org`; a successful build does
not establish a clean audit or real-device acceptance.

The npm registry audit on 2026-10-07 reported **24 advisories: 0 critical,
10 high, 11 moderate, 3 low** for the root client dependency tree. The pinned
ECharts 6.1.0 had no ECharts advisory in that result. This count is a dated
snapshot, not a continuing guarantee. Build and local disconnected H5 checks
do not verify live telemetry, real WeChat DevTools/device behavior, or App Store
and mini-program platform review; those checks have not been performed here.

Third-party code and artwork provenance are documented in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
