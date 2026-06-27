// src/experiments/strategy-critic/artifacts.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CandidateResult, EvalRunResult, ManifestMeta } from './types.ts';

export function slugLabel(label: string): string {
  return label.replace(/[/:=,]/g, '_');
}

export function compactTimestamp(date: Date): string {
  // 2026-06-27T15:30:00.000Z -> 20260627T153000Z
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Per candidate, writes one `<slug>.run<k>.json` per run (judge excluded), a
 * `<slug>.run<k>.judge.json` for runs that produced a judge verdict, and a
 * `<slug>.aggregate.json`. Plus a top-level `manifest.json`. Returns the written paths.
 */
export function writeRunArtifacts(outDir: string, meta: ManifestMeta, result: EvalRunResult): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];

  const byLabel = new Map<string, CandidateResult[]>();
  for (const c of result.perCandidate) {
    const arr = byLabel.get(c.label) ?? [];
    arr.push(c);
    byLabel.set(c.label, arr);
  }

  for (const [label, runs] of byLabel) {
    const slug = slugLabel(label);
    runs.forEach((candidate, i) => {
      const k = i + 1;
      const { judge, ...withoutJudge } = candidate;
      const runPath = join(outDir, `${slug}.run${k}.json`);
      writeJson(runPath, withoutJudge);
      written.push(runPath);
      if (judge != null) {
        const judgePath = join(outDir, `${slug}.run${k}.judge.json`);
        writeJson(judgePath, judge);
        written.push(judgePath);
      }
    });
    const aggregate = result.aggregates.find((a) => a.label === label);
    if (aggregate) {
      const aggPath = join(outDir, `${slug}.aggregate.json`);
      writeJson(aggPath, aggregate);
      written.push(aggPath);
    }
  }

  const manifestPath = join(outDir, 'manifest.json');
  writeJson(manifestPath, {
    timestamp: meta.timestamp,
    gitSha: meta.gitSha,
    harnessVersion: meta.harnessVersion,
    contractVersion: meta.contractVersion,
    mode: meta.mode,
    threshold: result.threshold,
    repeat: result.repeat,
    judgeEnabled: result.judgeEnabled,
    cases: result.cases,
    candidates: result.candidates.map((c) => c.label),
    perCandidate: result.aggregates.map((a) => ({
      label: a.label,
      aggregate: { passRate: a.passRate, detMean: a.det?.mean ?? null, judgeMean: a.judge?.mean ?? null, profileMean: a.profile?.mean ?? null },
    })),
    overallSuccess: result.overallSuccess,
  });
  written.push(manifestPath);

  return written;
}
