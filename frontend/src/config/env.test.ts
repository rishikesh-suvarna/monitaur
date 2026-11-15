import { describe, expect, it } from 'vitest';

import { buildAgentConfig, maskToken, resolveInstall, AGENT_CONFIG_PATH, AGENT_INSTALL_COMMAND } from '../lib/agentInstall';
import { makeServer } from '../test/fixtures';

import { EnvError, parseEnv, type EnvSource } from './env';

const COMPLETE: EnvSource = {
  VITE_APP_SERVER_URL: 'https://api.example.test/',
  VITE_APP_SERVER_WS_URL: 'wss://api.example.test',
  VITE_FIREBASE_API_KEY: 'key',
  VITE_FIREBASE_AUTH_DOMAIN: 'example.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'example',
  VITE_FIREBASE_APP_ID: '1:2:web:3',
};

describe('parseEnv', () => {
  it('derives the API base and agent endpoint', () => {
    const env = parseEnv(COMPLETE);
    expect(env.apiBaseUrl).toBe('https://api.example.test/api/v1');
    expect(env.agentEndpoint).toBe('wss://api.example.test/agent/connect');
    expect(env.firebase).not.toHaveProperty('storageBucket');
  });

  it('fails fast listing every missing variable', () => {
    const { VITE_APP_SERVER_URL: _url, VITE_FIREBASE_APP_ID: _app, ...partial } = COMPLETE;
    expect(() => parseEnv(partial)).toThrow(EnvError);
    try {
      parseEnv(partial);
    } catch (error) {
      expect((error as EnvError).missing).toEqual(['VITE_APP_SERVER_URL', 'VITE_FIREBASE_APP_ID']);
    }
  });

  it('turns App Check on only when its site key is set', () => {
    expect(parseEnv(COMPLETE)).not.toHaveProperty('appCheckSiteKey');
    expect(parseEnv({ ...COMPLETE, VITE_FIREBASE_APPCHECK_SITE_KEY: '  ' })).not.toHaveProperty('appCheckSiteKey');
    expect(parseEnv({ ...COMPLETE, VITE_FIREBASE_APPCHECK_SITE_KEY: '6Lc-site-key' }).appCheckSiteKey).toBe('6Lc-site-key');
  });

  it('rejects a WebSocket URL with the wrong scheme', () => {
    expect(() => parseEnv({ ...COMPLETE, VITE_APP_SERVER_WS_URL: 'https://api.example.test' })).toThrow(/invalid VITE_APP_SERVER_WS_URL/);
  });
});

describe('agent install', () => {
  const server = makeServer({ id: 1, name: 'web-01' });

  it('builds the real config.json keys when the API sends no config', () => {
    const install = resolveInstall(
      { server, token: 'tok_123456789abcdef', install: { command: '', config_path: '', config: '' } },
      'wss://api.example.test/agent/connect',
    );
    expect(install.command).toBe(AGENT_INSTALL_COMMAND);
    expect(install.configPath).toBe(AGENT_CONFIG_PATH);
    expect(JSON.parse(install.configText)).toEqual(buildAgentConfig('tok_123456789abcdef', 'wss://api.example.test/agent/connect', 'web-01'));
  });

  it('prefers the install block from the API', () => {
    const install = resolveInstall(
      { server, token: 't', install: { command: 'custom install', config_path: '/opt/agent.json', config: { token: 't', collection_interval: 10 } } },
      'wss://x',
    );
    expect(install.command).toBe('custom install');
    expect(install.configPath).toBe('/opt/agent.json');
    expect(JSON.parse(install.configText)).toEqual({ token: 't', collection_interval: 10 });
  });

  it('masks all but the ends of a token', () => {
    expect(maskToken('mt_live_7f3c9a1e5d0b48c2a6e1f9b42d')).toBe('mt_live_••••••••••••••••••••••b42d');
    expect(maskToken('short')).toBe('•••••');
  });
});
