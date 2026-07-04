import { describe, it, expect } from 'vitest';
import { selectSignedEvidence, parseSignedEvidenceSource } from './select-signed-evidence.ts';
import type { SignedEvidenceProvideArgs } from '../../ports/signed-evidence-provider.port.ts';
import { verifySignedEvidence, type EvidenceCheckScope } from '../../research/verify-signed-evidence.ts';

function expectedScope(args: SignedEvidenceProvideArgs): EvidenceCheckScope {
  return {
    bundleHash: args.bundleHash,
    datasetRef: args.datasetRef,
    window: { fromMs: Date.parse(args.window.from), toMs: Date.parse(args.window.to) },
    symbols: args.symbols,
    timeframe: args.timeframe,
  };
}

function argsFixture(): SignedEvidenceProvideArgs {
  return {
    backtesterRunId: 'run-1',
    bundleHash: 'sha256:deadbeef',
    datasetRef: 'binance-perp-1h',
    window: { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
    symbols: ['BTCUSDT'],
    timeframe: '1h',
  };
}

describe('parseSignedEvidenceSource', () => {
  it('defaults to none when unset', () => {
    expect(parseSignedEvidenceSource(undefined)).toBe('none');
  });
  it('accepts the known values', () => {
    expect(parseSignedEvidenceSource('none')).toBe('none');
    expect(parseSignedEvidenceSource('fixture')).toBe('fixture');
    expect(parseSignedEvidenceSource('http')).toBe('http');
  });
  it('throws (fail-closed) on an unknown value', () => {
    expect(() => parseSignedEvidenceSource('bogus')).toThrow(/none\|fixture\|http/);
  });
});

describe('selectSignedEvidence', () => {
  it('fixture source is refused in production (no override)', () => {
    expect(() =>
      selectSignedEvidence({ LAB_SIGNED_EVIDENCE_SOURCE: 'fixture' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/fixture.*NODE_ENV|LAB_ALLOW_FIXTURE_EVIDENCE/);
  });

  it('fixture source allowed under NODE_ENV=test', () => {
    const provider = selectSignedEvidence({
      LAB_SIGNED_EVIDENCE_SOURCE: 'fixture',
      NODE_ENV: 'test',
    } as unknown as NodeJS.ProcessEnv);
    expect(provider.available).toBe(true);
  });

  it('fixture source allowed under explicit override', () => {
    const provider = selectSignedEvidence({
      LAB_SIGNED_EVIDENCE_SOURCE: 'fixture',
      LAB_ALLOW_FIXTURE_EVIDENCE: 'true',
    } as unknown as NodeJS.ProcessEnv);
    expect(provider.available).toBe(true);
  });

  it('fixture provider resolves an evidence artifact scoped to the request args', async () => {
    const provider = selectSignedEvidence({
      LAB_SIGNED_EVIDENCE_SOURCE: 'fixture',
      NODE_ENV: 'test',
    } as unknown as NodeJS.ProcessEnv);
    const args = argsFixture();
    const evidence = await provider.provide(args);
    expect(evidence).not.toBeNull();
    expect(evidence?.body.backtesterRunId).toBe(args.backtesterRunId);
    expect(evidence?.body.bundleHash).toBe(args.bundleHash);
    expect(evidence?.body.window).toEqual({
      fromMs: Date.parse(args.window.from),
      toMs: Date.parse(args.window.to),
    });
  });

  it('fixture provider advertises a matching signer: its evidence verifies against provider.trustedSigners, and is rejected without it (regression: provider must not discard its own signer)', async () => {
    const provider = selectSignedEvidence({
      LAB_SIGNED_EVIDENCE_SOURCE: 'fixture',
      NODE_ENV: 'test',
    } as unknown as NodeJS.ProcessEnv);
    const args = argsFixture();
    const evidence = await provider.provide(args);
    expect(evidence).not.toBeNull();

    // The signer the provider advertises up-front verifies exactly what provide() signs — this is
    // what composition merges into the effective trustedSigners, so the paper.start verify passes.
    expect(provider.trustedSigners).toBeDefined();
    expect(verifySignedEvidence(evidence!, expectedScope(args), provider.trustedSigners!)).toEqual({
      ok: true,
    });

    // Without the provider's signer (the pre-fix composition wiring: env {} only), the SAME
    // evidence is fail-closed rejected — proving the merge is load-bearing, not incidental.
    expect(verifySignedEvidence(evidence!, expectedScope(args), {})).toEqual({
      ok: false,
      reason: 'evidence_signature_invalid',
    });
  });

  it('fixture provider signs every provide() with the SAME stable key (a per-call keypair would defeat the advertised signer)', async () => {
    const provider = selectSignedEvidence({
      LAB_SIGNED_EVIDENCE_SOURCE: 'fixture',
      NODE_ENV: 'test',
    } as unknown as NodeJS.ProcessEnv);
    const a = await provider.provide(argsFixture());
    const b = await provider.provide({ ...argsFixture(), backtesterRunId: 'run-2' });
    expect(a?.body.keyId).toBe(b?.body.keyId);
    expect(Object.keys(provider.trustedSigners!)).toEqual([a?.body.keyId]);
  });

  it('none source → available false, provide null', async () => {
    const provider = selectSignedEvidence({} as NodeJS.ProcessEnv);
    expect(provider.available).toBe(false);
    expect(await provider.provide(argsFixture())).toBeNull();
  });

  it('http source is available but not yet fetchable', async () => {
    const provider = selectSignedEvidence({
      LAB_SIGNED_EVIDENCE_SOURCE: 'http',
    } as unknown as NodeJS.ProcessEnv);
    expect(provider.available).toBe(true);
    expect(await provider.provide(argsFixture())).toBeNull();
  });
});
