import { describe, it, expect } from 'vitest';
import {
  RESEARCHER_CAPABILITIES, RESEARCHER_PROFIT_FRAMING, RESEARCHER_PROFILE_CRITICAL_FRAMING,
} from './researcher-capabilities.ts';

describe('researcher capability framings', () => {
  it('profit framing names exit-improvement levers', () => {
    expect(RESEARCHER_PROFIT_FRAMING).toMatch(/take-profit|take profit/i);
    expect(RESEARCHER_PROFIT_FRAMING).toMatch(/trail/i);
    expect(RESEARCHER_PROFIT_FRAMING).toMatch(/@post|after exit|left on the table/i);
  });

  it('profile-critical framing permits relaxing/removing/replacing checks', () => {
    expect(RESEARCHER_PROFILE_CRITICAL_FRAMING).toMatch(/relax|remove|replace/i);
    expect(RESEARCHER_PROFILE_CRITICAL_FRAMING).toMatch(/allow_entry/);
    expect(RESEARCHER_PROFILE_CRITICAL_FRAMING).toMatch(/no_op/);
    expect(RESEARCHER_PROFILE_CRITICAL_FRAMING).toMatch(/not (only|just) add/i);
  });

  it('base capabilities still carry the runner-owned guard', () => {
    expect(RESEARCHER_CAPABILITIES).toMatch(/runner-owned/);
  });
});
