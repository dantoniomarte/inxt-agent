import { homedir } from 'node:os';
import { join } from 'node:path';

/** Process-wide configuration for inxt-agent. Values verified against internxt/cli .env.template. */
export interface AgentConfig {
  /** Drive API (storage CRUD by uuid, users refresh, trash). */
  driveApiUrl: string;
  /** Bridge/network API (encrypted transfers). */
  networkUrl: string;
  /** Web app used for the universal-link browser login. */
  driveWebUrl: string;
  /** `internxt-client` header identity. Defaults to the web client's. */
  clientName: string;
  clientVersion: string;
  /** Directory holding credentials.json (0600) and cache. */
  dataDir: string;
}

export const DEFAULT_CONFIG: AgentConfig = {
  driveApiUrl: 'https://gateway.internxt.com/drive',
  networkUrl: 'https://gateway.internxt.com/network',
  driveWebUrl: 'https://drive.internxt.com',
  clientName: 'drive-web',
  clientVersion: '1.0.0',
  dataDir: process.env.INXT_AGENT_DATA_DIR ?? join(homedir(), '.config', 'inxt-agent'),
};

export function loadConfig(): AgentConfig {
  const env = (key: string): string | undefined => {
    const v = process.env[key];
    return v && v.length > 0 ? v : undefined;
  };
  return {
    driveApiUrl: env('INXT_DRIVE_API_URL') ?? DEFAULT_CONFIG.driveApiUrl,
    networkUrl: env('INXT_NETWORK_URL') ?? DEFAULT_CONFIG.networkUrl,
    driveWebUrl: env('INXT_DRIVE_WEB_URL') ?? DEFAULT_CONFIG.driveWebUrl,
    clientName: env('INXT_CLIENT_NAME') ?? DEFAULT_CONFIG.clientName,
    clientVersion: DEFAULT_CONFIG.clientVersion,
    dataDir: DEFAULT_CONFIG.dataDir,
  };
}
