# trading-lab

Research-only multi-agent system over trading-platform. Research brain; no live authority.

## Dev

    pnpm install
    docker compose up -d
    cp .env.example .env
    pnpm db:generate && pnpm db:migrate
    pnpm test

## Run (SP-1 foundation slice)

    pnpm ingress   # POST /tasks
    pnpm worker    # consumes queue, dispatches via WorkflowRouter

Design: docs/superpowers/specs/2026-06-10-trading-lab-design.md

## Platform capability discovery (SP-7 slice 1)

Read-only probe of the `trading-platform` research gateway over MCP — no execution, no DB, no
runtime boot. It spawns the gateway over stdio (anonymous, zero secrets), calls
`discover_research_contract` + `list_datasets`, audits the five `platform.*` AgentEvents to stdout,
prints the capability descriptor + datasets, and exits non-zero on a contract mismatch / timeout /
unreachable gateway (fail-closed).

The research gateway is a **separate trading-platform service**, reached only through runtime env
(`TRADING_PLATFORM_GATEWAY_COMMAND` / `TRADING_PLATFORM_GATEWAY_ARGS`) — it is not an install or
build dependency of trading-lab. For a local dev run you can point it at a checked-out platform
gateway, e.g.:

```bash
TRADING_PLATFORM_GATEWAY_COMMAND=node \
TRADING_PLATFORM_GATEWAY_ARGS="--experimental-strip-types /path/to/trading-platform/src/research/mcp-gateway/bin/start-gateway.ts" \
pnpm platform:discover
```

The contract-version handshake is mandatory and fail-closed, but on-demand only: it never blocks
`pnpm worker` / `pnpm ingress` boot. The runtime gate is `TRADING_PLATFORM_INTEGRATION` (`mock`
default); the SDK import is confined to `src/ports/research-platform.port.ts` + `src/adapters/platform/`.

### Dependency note (vendored standalone SDK)

`@trading-platform/sdk` is consumed as a **vendored standalone tarball**, committed at
`vendor/trading-platform-sdk/`. The root `package.json` depends on it via
`file:./vendor/trading-platform-sdk/trading-platform-sdk-0.1.0.tgz`. No sibling
`../trading-platform` checkout, pnpm override, or workspace link is needed to install, typecheck,
or test trading-lab — the SDK is a self-contained consumer package (`dependencies: decimal.js`;
`@modelcontextprotocol/sdk` optional peer). See `vendor/trading-platform-sdk/README.md` for the
SDK version, source commit, and the command to refresh the tarball. This vendored channel is
temporary until the SDK is published to a private registry.
