# Vendored `@trading-platform/sdk`

A **vendored standalone build** of `@trading-platform/sdk`, committed so trading-lab can consume
the SDK as a `file:` tarball dependency in the root `package.json`
(`file:./vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz`) — no sibling
`../trading-platform` source checkout required.

| Field | Value |
|-------|-------|
| Package | `@trading-platform/sdk` |
| Version | `0.1.0` |
| Tarball | `trading-platform-sdk-0.1.0.tgz` |
| Source repo | `trading-platform` |
| Source commit | `647b13bd8ebdd686660c97ef1fd2cfeaedd54aed` |

## Why this exists

The SDK is a private package with no public npm registry. Until a private registry
(e.g. GitHub Packages / Verdaccio) is available, trading-lab consumes the SDK as a committed
tarball — a **temporary delivery channel**. The SDK is a standalone consumer package
(trading-platform feature 034): it has no `trading-platform` / `trading-bot-platform` /
`workspace:*` dependency (`dependencies: decimal.js`; `@modelcontextprotocol/sdk` optional peer).

## Refreshing the tarball

From the trading-lab repo root, with a built `../trading-platform/packages/sdk/dist` present:

```bash
npm pack ../trading-platform/packages/sdk --pack-destination vendor/trading-platform-sdk
```

(`--pack-destination` requires npm ≥ 7.)

Then: bump the version in the filename + this README + the source commit SHA, update the `file:`
path in the root `package.json`, run `pnpm install`, and re-run the SP-8 acceptance gates
(see `docs/superpowers/specs/2026-06-15-trading-lab-sp8-standalone-sdk-design.md`).

Sanity-check before committing a new tarball:

```bash
tar -tzf vendor/trading-platform-sdk/trading-platform-sdk-<version>.tgz
tar -xOf vendor/trading-platform-sdk/trading-platform-sdk-<version>.tgz package/package.json
```

Inspect the `dependencies` / `peerDependencies` fields (the `description` field legitimately
contains the words "trading-platform"). They must NOT declare `trading-platform`,
`trading-bot-platform`, or a `workspace:*` dependency. If they do, fix trading-platform
feature 034 — do not work around it in trading-lab.
