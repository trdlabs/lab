import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { installProcessSafetyNet } from './process-safety.ts';

describe('installProcessSafetyNet', () => {
  it('routes an unhandledRejection to the fatal handler and logger', () => {
    const proc = new EventEmitter();
    const onFatal = vi.fn();
    const logger = vi.fn();
    installProcessSafetyNet({ onFatal, logger, proc });

    const reason = new Error('boom');
    proc.emit('unhandledRejection', reason);

    expect(logger).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledWith(reason, 'unhandledRejection');
  });

  it('routes an uncaughtException to the fatal handler', () => {
    const proc = new EventEmitter();
    const onFatal = vi.fn();
    installProcessSafetyNet({ onFatal, proc });

    const reason = new Error('crash');
    proc.emit('uncaughtException', reason);

    expect(onFatal).toHaveBeenCalledWith(reason, 'uncaughtException');
  });
});
