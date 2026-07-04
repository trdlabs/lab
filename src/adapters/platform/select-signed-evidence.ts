import type {
  SignedEvidenceProviderPort,
  SignedEvidenceProvideArgs,
} from '../../ports/signed-evidence-provider.port.ts';
import type { SignedBacktestEvidence } from '../../ports/backtester-strategy.port.ts';
import { buildFixtureSignedEvidence } from '../../research/fixture-signed-evidence.ts';

export type SignedEvidenceSource = 'none' | 'fixture' | 'http';

/** Validate the env string against the union; fail closed on anything unknown. */
export function parseSignedEvidenceSource(raw: string | undefined): SignedEvidenceSource {
  if (raw === undefined || raw === '') return 'none';
  if (raw === 'none' || raw === 'fixture' || raw === 'http') return raw;
  throw new Error(`LAB_SIGNED_EVIDENCE_SOURCE must be one of none|fixture|http, got '${raw}'`);
}

class NoneSignedEvidenceProvider implements SignedEvidenceProviderPort {
  readonly available = false;
  async provide(): Promise<SignedBacktestEvidence | null> {
    return null;
  }
}

/** TEST/DEMO ONLY — generates its own keypair per call; only verifies against the
 * trustedSigners IT produced. Never wire this into a production source. */
class FixtureSignedEvidenceProvider implements SignedEvidenceProviderPort {
  readonly available = true;
  async provide(args: SignedEvidenceProvideArgs): Promise<SignedBacktestEvidence | null> {
    const { evidence } = buildFixtureSignedEvidence({
      backtesterRunId: args.backtesterRunId,
      bundleHash: args.bundleHash,
      datasetRef: args.datasetRef,
      window: { fromMs: Date.parse(args.window.from), toMs: Date.parse(args.window.to) },
      symbols: args.symbols,
      timeframe: args.timeframe,
    });
    return evidence;
  }
}

class HttpSignedEvidenceProvider implements SignedEvidenceProviderPort {
  readonly available = true;
  async provide(): Promise<SignedBacktestEvidence | null> {
    // TODO(079-followup): wire to backtester GET /v1/runs/:id/evidence once Deliverable A ships
    return null;
  }
}

/** Boot-safe selector for signed backtest evidence. Reads its OWN env, never process.env directly. */
export function selectSignedEvidence(source: NodeJS.ProcessEnv): SignedEvidenceProviderPort {
  const sourceKind = parseSignedEvidenceSource(source.LAB_SIGNED_EVIDENCE_SOURCE);
  if (sourceKind === 'fixture') {
    const allowed = source.NODE_ENV === 'test' || source.LAB_ALLOW_FIXTURE_EVIDENCE === 'true';
    if (!allowed) {
      throw new Error(
        'LAB_SIGNED_EVIDENCE_SOURCE=fixture is refused outside NODE_ENV=test without ' +
          'LAB_ALLOW_FIXTURE_EVIDENCE=true (fixture evidence self-signs and must never gate production paper.start)',
      );
    }
    return new FixtureSignedEvidenceProvider();
  }
  if (sourceKind === 'http') {
    return new HttpSignedEvidenceProvider();
  }
  return new NoneSignedEvidenceProvider();
}
