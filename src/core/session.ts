import { Drive } from '@internxt/sdk';
import type { AppDetails, ApiSecurity } from '@internxt/sdk/dist/shared/index.js';
import type { AgentConfig } from './config.js';
import { toAgentError } from './errors.js';

/**
 * Minimal wrapper over @internxt/sdk factories (same call pattern as the official CLI's
 * SdkManager). Clients are created per call: the SDK keeps no durable connection state and
 * axios reuses keep-alive sockets under the hood, so this stays allocation-cheap.
 */

export function appDetails(config: AgentConfig): AppDetails {
  return { clientName: config.clientName, clientVersion: config.clientVersion };
}

function apiSecurity(token: string): ApiSecurity {
  return {
    token,
    // SDK auto-retries on 429 with backoff; unauthorizedCallback reserved for session use.
    retryOptions: { maxRetries: 3 },
  };
}

export function storageClient(config: AgentConfig, token: string): Drive.Storage {
  return Drive.Storage.client(config.driveApiUrl, appDetails(config), apiSecurity(token));
}

export function usersClient(config: AgentConfig, token: string): Drive.Users {
  return Drive.Users.client(config.driveApiUrl, appDetails(config), apiSecurity(token));
}

export function trashClient(config: AgentConfig, token: string): Drive.Trash {
  return Drive.Trash.client(config.driveApiUrl, appDetails(config), apiSecurity(token));
}

/**
 * Run `fn` once; on a 401 response call `refreshToken` and retry exactly once.
 * The refresh promise is provided by the session layer (single-flight), so concurrent
 * callers share one HTTP refresh. Anything else propagates as AgentError.
 */
export async function withAuthRetry<T>(fn: (token: string) => Promise<T>, token: string, refreshToken: () => Promise<string>): Promise<T> {
  try {
    return await fn(token);
  } catch (e) {
    const err = toAgentError(e);
    if (err.code !== 'AUTH_EXPIRED') throw err;
    const fresh = await refreshToken();
    return await fn(fresh);
  }
}
