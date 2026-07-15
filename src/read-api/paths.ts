// Shared read-API path contract. READ_API_V1_PREFIX is the mount prefix for the
// entire /v1 read surface (app.route(READ_API_V1_PREFIX, v1) in read-app.ts) —
// it deliberately lives here, not in any feature module, so the app does not
// depend back on a single feature. CYCLE_SCORECARD_ROUTE is registered relative
// to that sub-app; cycleScorecardMarkdownUrl re-materializes the SAME template
// with the /v1 prefix so an external consumer (Office, R5d) fetches exactly what
// the app serves — route template and URL derived from one string, no drift.
export const READ_API_V1_PREFIX = '/v1';
export const CYCLE_SCORECARD_ROUTE = '/cycles/:correlationId/scorecard';

export function cycleScorecardMarkdownUrl(correlationId: string): string {
  const path = CYCLE_SCORECARD_ROUTE.replace(':correlationId', encodeURIComponent(correlationId));
  return `${READ_API_V1_PREFIX}${path}?format=markdown`;
}
