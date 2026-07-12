/**
 * paper:monitor:resume — re-enqueue paper.monitor tasks for actively-watched paper submissions
 * after a Redis job loss.
 *
 * Why this exists (docs/superpowers/specs/2026-07-03-paper-monitor-design.md §9): `paper.monitor`
 * self-reschedules via BullMQ delayed jobs (up to PAPER_MONITOR_POLL_MS apart, default 6h).
 * BullMQ delayed jobs live in Redis, not Postgres — if Redis is lost entirely (not just
 * restarted; a restart keeps its persisted jobs), every in-flight delayed `paper.monitor` job
 * disappears silently and the corresponding paper_submission row is stuck `monitor_status =
 * 'watching'` forever with nothing left to advance it. This CLI is the batch recovery: scan the
 * ledger for `watching` rows (source of truth — Postgres, not Redis) and re-enqueue one
 * `paper.monitor` task per row.
 *
 * Dedupe rationale: resume CANNOT reuse the dedupeKey of an already-created delayed task
 * (`paper.monitor:${experimentId}:${attempt}`) — `createAndEnqueueTask` finds the existing DB
 * task row by dedupeKey and returns early WITHOUT touching the queue, so the (now-vanished) Redis
 * job would never actually be recreated. There is also no cheap way to know the max attempt
 * number already used for a row. So resume mints a fresh, time-scoped dedupeKey instead:
 * `paper.monitor:${experimentId}:resume-${YYYYMMDDHHmm}` (minute granularity). This guarantees
 * every resume run creates a genuinely new job, while a double invocation of this CLI within the
 * same minute (e.g. an operator running it twice, or a supervisor retry) dedupes against itself
 * instead of double-enqueuing. `delayMs` is omitted (BullMQ default = immediate) — resume implies
 * "check right now", not "wait another poll interval".
 *
 * The resumed task also carries a FRESH monitor `epoch` (Date.now()) so its self-reschedules
 * (paper.monitor:<exp>:<epoch>:<attempt>) live in their own namespace and are never dedup-swallowed
 * by the original — now-dead — chain's already-created attempt keys.
 *
 * Boots the DB-backed runtime (like `pnpm worker` / `pnpm platform:resume`); all decisions are
 * data-driven from the paper_submission ledger, no in-process state.
 *
 * Typecheck (file is OUTSIDE tsconfig include — manual invocation, mirrors
 * scripts/run-strategy-baseline.mts / scripts/platform-resume.ts headers):
 *   npx tsc --noEmit --module nodenext --moduleResolution nodenext \
 *     --target es2022 --strict --allowImportingTsExtensions --skipLibCheck \
 *     scripts/paper-monitor-resume.mts
 */
import { pathToFileURL } from 'node:url';
import { composeRuntime } from '../src/composition.ts';
import { createAndEnqueueTask } from '../src/orchestrator/task-intake.ts';

function resumeStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
}

async function main(): Promise<{ total: number; resumed: { experimentId: string; taskId: string; deduped: boolean }[] }> {
  const { services, queue, pool } = composeRuntime();
  try {
    const watching = await services.paperSubmissions.listWatching();
    const stamp = resumeStamp(new Date());
    const resumed: { experimentId: string; taskId: string; deduped: boolean }[] = [];

    for (const sub of watching) {
      const result = await createAndEnqueueTask(
        {
          taskType: 'paper.monitor',
          source: 'platform',
          payload: { experimentId: sub.experimentId, attempt: 0, epoch: Date.now() },
          dedupeKey: `paper.monitor:${sub.experimentId}:resume-${stamp}`,
        },
        { repo: services.researchTasks, queue: services.taskQueue },
      );
      resumed.push({ experimentId: sub.experimentId, taskId: result.taskId, deduped: result.deduped });
    }

    return { total: watching.length, resumed };
  } finally {
    await queue.close();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let code = 0;
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err: unknown) {
    process.stderr.write(`paper:monitor:resume failed: ${err instanceof Error ? err.message : String(err)}\n`);
    code = 1;
  } finally {
    process.exit(code);
  }
}
