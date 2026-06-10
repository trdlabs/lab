import type { WorkflowHandler } from '../workflow-router.ts';

/**
 * SP-1 no-op stub proving Ingress→queue→worker→router wiring. Replaced by real
 * workflows in SP-2+. The handler does NOT own status transitions: the worker
 * owns the generic running → completed/failed transition (see Task 13).
 */
export const echoHandler: WorkflowHandler = async () => {
  // intentionally empty: success is signalled by returning without throwing
};
