import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * office-server refuses to start in connected mode without OFFICE_OPERATOR_PASSWORD
 * (trading-office, SEC-O1). Lab owns the compose file that runs it, so lab owns the wiring —
 * and these two repos must land together: the guard without the passthrough is a stack that
 * cannot boot, the passthrough without the guard is the bypass the audit found.
 *
 * The env templates are asserted EMPTY on purpose. A committed placeholder is a working
 * password the moment the file is copied, and lab compose can publish office-server on a
 * non-loopback BIND_ADDR — so "it's only the demo file" is not a safe assumption.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name: string): string => readFileSync(join(repoRoot, name), 'utf8');

const ENV_TEMPLATES = ['.env.vps.example', '.env.local.example', '.env.demo.example'];

describe('office operator password wiring', () => {
  it('base compose passes the password through to office-server', () => {
    const compose = read('docker-compose.yml');
    const officeServer = compose.slice(compose.indexOf('\n  office-server:'));
    expect(officeServer).toContain('OFFICE_OPERATOR_PASSWORD: ${OFFICE_OPERATOR_PASSWORD:-}');
  });

  it('compose never supplies a fallback password of its own', () => {
    const compose = read('docker-compose.yml');
    // `${OFFICE_OPERATOR_PASSWORD:-anything}` would hand every deployment the same known
    // password and quietly satisfy the office-side guard.
    const fallbacks = [...compose.matchAll(/\$\{OFFICE_OPERATOR_PASSWORD:-(.*?)\}/g)].map((m) => m[1]);
    expect(fallbacks).toEqual(['']);
  });

  it.each(ENV_TEMPLATES)('%s declares the key so operators cannot miss it', (file) => {
    expect(read(file)).toMatch(/^OFFICE_OPERATOR_PASSWORD=/m);
  });

  it.each(ENV_TEMPLATES)('%s ships no value — not even a dev placeholder', (file) => {
    const line = read(file).split('\n').find((l) => l.startsWith('OFFICE_OPERATOR_PASSWORD='));
    expect(line).toBe('OFFICE_OPERATOR_PASSWORD=');
  });

  it.each(ENV_TEMPLATES)('%s explains that connected mode stays down until it is provisioned', (file) => {
    const body = read(file);
    const idx = body.indexOf('OFFICE_OPERATOR_PASSWORD=');
    const preamble = body.slice(Math.max(0, idx - 600), idx);
    expect(preamble).toMatch(/refuses to start|REFUSES TO START/);
  });
});
