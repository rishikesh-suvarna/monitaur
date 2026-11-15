import { describe, expect, it } from 'vitest';

import { makeServer } from '../../test/fixtures';

import { graceCountdown, maskedTokenPrefix, rotatedInstall } from './token';

describe('maskedTokenPrefix', () => {
  it('shows only the stored prefix', () => {
    expect(maskedTokenPrefix('mt_live_7f3c')).toBe('mt_live_7f3c••••••••••••');
  });
});

describe('graceCountdown', () => {
  const now = Date.parse('2026-11-15T14:27:00Z');

  it('counts down to previous_valid_until', () => {
    expect(graceCountdown('2026-11-15T14:36:58Z', now)).toMatchObject({ expired: false, remaining: '9:58' });
  });

  it('reports expiry and ignores bad input', () => {
    expect(graceCountdown('2026-11-15T14:20:00Z', now)).toMatchObject({ expired: true, remaining: '0:00' });
    expect(graceCountdown('not a time', now)).toBeNull();
  });
});

describe('rotatedInstall', () => {
  const server = makeServer({ id: 1, name: 'db-primary' });

  it('prefers the config the API rendered', () => {
    const install = rotatedInstall(
      { token: 'mt_live_new', previous_valid_until: '', install: { command: 'curl x | sudo bash', config_path: '/etc/monitaur/config.json', config: '{"token":"mt_live_new"}' } },
      server,
      'wss://api.example.com/agent/connect',
    );
    expect(install).toEqual({ command: 'curl x | sudo bash', configPath: '/etc/monitaur/config.json', configText: '{"token":"mt_live_new"}', token: 'mt_live_new' });
  });

  it('builds the agent config when the response has none', () => {
    const install = rotatedInstall({ token: 'mt_live_new', previous_valid_until: '' }, server, 'wss://api.example.com/agent/connect');
    expect(JSON.parse(install.configText)).toMatchObject({ token: 'mt_live_new', api_endpoint: 'wss://api.example.com/agent/connect', server_name: 'db-primary' });
    expect(install.configPath).toBe('/etc/monitaur/config.json');
  });
});
