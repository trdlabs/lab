// Process-level safety net: an unhandled promise rejection or uncaught exception must
// not silently take the process down. Both entrypoints (worker, ingress) install this so
// a stray rejection (e.g. a fire-and-forget reschedule) triggers a logged, graceful
// shutdown instead of an opaque crash under `restart: "no"`.
type FatalKind = 'unhandledRejection' | 'uncaughtException';

export interface ProcessSafetyDeps {
  onFatal: (reason: unknown, kind: FatalKind) => void;
  logger?: (message: string, reason: unknown) => void;
  proc?: NodeJS.EventEmitter;
}

export function installProcessSafetyNet(deps: ProcessSafetyDeps): void {
  const proc = deps.proc ?? process;
  const log = deps.logger ?? ((message, reason) => console.error(message, reason));
  const handle = (kind: FatalKind) => (reason: unknown) => {
    log(`[fatal] ${kind}`, reason);
    deps.onFatal(reason, kind);
  };
  proc.on('unhandledRejection', handle('unhandledRejection'));
  proc.on('uncaughtException', handle('uncaughtException'));
}
