# long_oi strategy code (vendored fixture)

Byte-identical copy of `trading-platform/src/strategies/long_oi/*.ts`, vendored into trading-lab so
the analyst eval + `scripts/regen-from-code.mts` are self-contained (no sibling repo needed). Treated
as third-party strategy code, NOT compiled (lives under `docs/`, outside `tsconfig.include`).

To re-vendor (only if the upstream long_oi changes): copy the files again and run
`src/experiments/strategy-analyst/__fixtures__/long-oi-code-fingerprint.test.ts`. If the fingerprint
guard fails, the code changed → regenerate the golden with `scripts/regen-from-code.mts` (one LLM call).
