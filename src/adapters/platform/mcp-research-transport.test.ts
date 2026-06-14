import { describe, it, expect } from 'vitest';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import { loadResearchPlatformConfig, buildChildEnv, withTimeout } from './mcp-research-transport.ts';

describe('loadResearchPlatformConfig', () => {
  it('parses TRADING_PLATFORM_* with defaults', () => {
    const cfg = loadResearchPlatformConfig({
      TRADING_PLATFORM_GATEWAY_COMMAND: 'node',
      TRADING_PLATFORM_GATEWAY_ARGS: '--experimental-strip-types ../tp/bin/start.ts',
    });
    expect(cfg.command).toBe('node');
    expect(cfg.args).toEqual(['--experimental-strip-types', '../tp/bin/start.ts']);
    expect(cfg.discoveryTimeoutMs).toBe(15000);
    expect(cfg.expectedContractVersion).toBe(CONTRACT_VERSION);
    expect(cfg.gatewayConfigPath).toBeUndefined();
  });

  it('honors overrides', () => {
    const cfg = loadResearchPlatformConfig({
      TRADING_PLATFORM_GATEWAY_COMMAND: 'node',
      TRADING_PLATFORM_GATEWAY_CONFIG: '/etc/gw.json',
      TRADING_PLATFORM_DISCOVERY_TIMEOUT_MS: '500',
      TRADING_PLATFORM_EXPECTED_CONTRACT: '031.7',
    });
    expect(cfg.gatewayConfigPath).toBe('/etc/gw.json');
    expect(cfg.discoveryTimeoutMs).toBe(500);
    expect(cfg.expectedContractVersion).toBe('031.7');
  });

  it('throws when the gateway command is missing', () => {
    expect(() => loadResearchPlatformConfig({})).toThrow(/TRADING_PLATFORM_GATEWAY_COMMAND/);
  });
});

describe('buildChildEnv', () => {
  it('maps gatewayConfigPath to MCP_GATEWAY_CONFIG and drops undefined base entries', () => {
    const cfg = loadResearchPlatformConfig({ TRADING_PLATFORM_GATEWAY_COMMAND: 'node', TRADING_PLATFORM_GATEWAY_CONFIG: '/etc/gw.json' });
    const env = buildChildEnv(cfg, { KEEP: 'yes', DROP: undefined });
    expect(env.KEEP).toBe('yes');
    expect('DROP' in env).toBe(false);
    expect(env.MCP_GATEWAY_CONFIG).toBe('/etc/gw.json');
  });

  it('omits MCP_GATEWAY_CONFIG when no gateway config path', () => {
    const cfg = loadResearchPlatformConfig({ TRADING_PLATFORM_GATEWAY_COMMAND: 'node' });
    const env = buildChildEnv(cfg, {});
    expect('MCP_GATEWAY_CONFIG' in env).toBe(false);
  });
});

describe('withTimeout', () => {
  it('resolves when the promise settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'x')).resolves.toBe(7);
  });

  it('rejects with a labeled error when the promise is too slow', async () => {
    const slow = new Promise((r) => setTimeout(() => r(1), 50));
    await expect(withTimeout(slow, 5, 'discover')).rejects.toThrow(/discover timed out after 5ms/);
  });
});
