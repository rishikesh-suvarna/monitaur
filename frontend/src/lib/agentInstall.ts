/**
 * Real agent install facts (docs/platform-v2.md section 5, install.sh and
 * agent/config/config.go). The backend's POST /servers `install` block wins
 * when it is filled in; these are the fallback.
 */
import type { CreateServerResponse } from '../api/types';

/** README section that installs or upgrades the agent (re-running the installer upgrades in place). */
export const AGENT_UPDATE_URL = 'https://github.com/rishikesh-suvarna/monitaur#install-agent-ubuntudebian';

export const AGENT_INSTALL_COMMAND =
  'curl -sSL https://raw.githubusercontent.com/rishikesh-suvarna/monitaur/main/install.sh | sudo bash';
export const AGENT_CONFIG_PATH = '/etc/monitaur/config.json';
export const AGENT_SERVICE_NAME = 'monitaur-agent';
export const AGENT_START_COMMAND = `sudo systemctl enable --now ${AGENT_SERVICE_NAME}`;
export const AGENT_STATUS_COMMAND = `sudo systemctl status ${AGENT_SERVICE_NAME}`;
export const AGENT_LOGS_COMMAND = `sudo journalctl -u ${AGENT_SERVICE_NAME} -n 50`;
/** The agent's default (agent/config/config.go). */
export const DEFAULT_COLLECTION_INTERVAL_S = 5;

const TOKEN_VISIBLE_PREFIX = 8;
const TOKEN_VISIBLE_SUFFIX = 4;
const MASK_CHAR = '•';
const JSON_INDENT = 2;

/** The keys agent/config/config.go reads from config.json. */
export interface AgentConfig {
  token: string;
  api_endpoint: string;
  collection_interval: number;
  server_name: string;
}

export function buildAgentConfig(token: string, agentEndpoint: string, serverName: string): AgentConfig {
  return {
    token,
    api_endpoint: agentEndpoint,
    collection_interval: DEFAULT_COLLECTION_INTERVAL_S,
    server_name: serverName,
  };
}

/** "mt_live_7f3c••••••••b42d": enough to recognise, not enough to use. */
export function maskToken(token: string): string {
  if (token.length <= TOKEN_VISIBLE_PREFIX + TOKEN_VISIBLE_SUFFIX) return MASK_CHAR.repeat(token.length);
  const hidden = token.length - TOKEN_VISIBLE_PREFIX - TOKEN_VISIBLE_SUFFIX;
  return `${token.slice(0, TOKEN_VISIBLE_PREFIX)}${MASK_CHAR.repeat(hidden)}${token.slice(-TOKEN_VISIBLE_SUFFIX)}`;
}

export interface ResolvedInstall {
  command: string;
  configPath: string;
  /** Exact config file contents, token included. */
  configText: string;
  token: string;
}

/** Install instructions for a newly created server, preferring what the API returned. */
export function resolveInstall(response: CreateServerResponse, agentEndpoint: string): ResolvedInstall {
  const install = response.install as Partial<CreateServerResponse['install']> | undefined;
  // Typed loosely on purpose: section 4 does not pin down this field's shape.
  const fromApi: unknown = install?.config;
  let configText: string;
  if (typeof fromApi === 'string' && fromApi.trim() !== '') configText = fromApi;
  else if (fromApi !== null && typeof fromApi === 'object' && Object.keys(fromApi).length > 0)
    configText = JSON.stringify(fromApi, null, JSON_INDENT);
  else configText = JSON.stringify(buildAgentConfig(response.token, agentEndpoint, response.server.name), null, JSON_INDENT);

  return {
    command: install?.command?.trim() ? install.command : AGENT_INSTALL_COMMAND,
    configPath: install?.config_path?.trim() ? install.config_path : AGENT_CONFIG_PATH,
    configText,
    token: response.token,
  };
}
