
/** The queue lanes the router dispatches to. See slice spec 2026-07-11-lab-revision-lane-routing. */
export type QueueLane = 'default' | 'revision';

/**
 * Pure routing policy — the single point that decides which lane a task type runs on.
 * revision.build / revision.consolidate carry the UNIQUE(profile, version) race and their
 * own backtester-submits, so they run on an isolated revision lane. Everything else — and any
 * unrecognised type — goes to the default lane.
 */
export function routeTaskType(taskType: string): QueueLane {
  return taskType === 'revision.build' || taskType === 'revision.consolidate' ? 'revision' : 'default';
}
