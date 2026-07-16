import { describe, it, expect } from "vitest";
import { InMemoryLexicalSimilarHypothesisSearch } from "./in-memory-lexical-similar-hypothesis-search.ts";
import type { HypothesisProposalRepository } from "../../ports/hypothesis-proposal.repository.ts";
import type { HypothesisProposal } from "../../domain/hypothesis.ts";

describe("outcome embargo (S4) — SimilarHypothesisSummary shape", () => {
  it("returns exactly {hypothesisId, thesis, status, score} even when proposals carry outcome data", async () => {
    const proposal = {
      id: "h1", strategyProfileId: "p1", thesis: "oi recovery bounce", status: "proxy_failed",
      proxyMetrics: { decision: "FAIL", backtestRunId: "bt1", deltaNetPnlUsd: -5, deltaMaxDrawdownPct: 1 },
      holdoutValidation: { holdoutSharpe: 987654.321 }, // runtime extra
    } as unknown as HypothesisProposal;
    const repo = { listByStrategyProfile: async () => [proposal] } as unknown as HypothesisProposalRepository;
    const search = new InMemoryLexicalSimilarHypothesisSearch(repo);

    const hits = await search.search("p1", "oi recovery", 5);

    expect(hits).toHaveLength(1);
    expect(Object.keys(hits[0]!).sort()).toEqual(["hypothesisId", "score", "status", "thesis"]);
    expect(JSON.stringify(hits)).not.toContain("987654");
    expect(JSON.stringify(hits)).not.toContain("deltaNetPnlUsd");
  });
});
