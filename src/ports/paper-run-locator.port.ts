/**
 * Locates the live paper-mode run that corresponds to a submitted paper strategy, by joining on
 * strategy name + submission time. This is the seam that isolates the candidateId->runId gap: the
 * platform does not yet hand back a runId at submission time, so callers must locate the run after
 * the fact via BotResultsReadPort.listBotRuns.
 */
export interface PaperRunLocatorPort {
  locate(args: {
    strategyName: string;
    submittedAtMs: number;
  }): Promise<{ runId: string; startedAtMs: number } | null>;
}
