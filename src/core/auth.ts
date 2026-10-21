import { Drive, Auth } from '@internxt/sdk';
import { AgentError, sanitizeMessage } from './errors.js';
import type { AgentConfig } from './config.js';
import { appDetails } from './session.js';
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  type StoredCredentials,
  type StoredUser,
} from './credentials.js';
import { startCallbackServer } from './login.js';
import { parseCallbackUrl, assertMnemonicShape, type CallbackParams } from './headless.js';

/**
 * High-level auth: browser login via universal-link, single-flight token refresh using the
 * WEB surface (`GET /users/refresh` — the endpoint drive-web itself uses, not tier-gated),
 * status and logout. CLI-gated endpoints (`/users/cli/refresh`, 402 "tier does not allow
 * CLI access") are deliberately never called.
 */

/** Structural type of GET /users/refresh (RefreshUserTokensDto + UserResponseDto). */
type RefreshUserDto = {
  uuid: string;
  email: string;
  userId: string;
  bridgeUser: string;
  bucket: string;
  rootFolderId: string;
  keys?: { ecc?: { publicKey?: string | null } } | null;
};
type RefreshResponse = { newToken: string; user: RefreshUserDto };

async function fetchFreshSession(config: AgentConfig, token: string): Promise<RefreshResponse> {
  const users = Drive.Users.client(config.driveApiUrl, appDetails(config), { token });
  try {
    const res = (await users.refreshUser()) as unknown as RefreshResponse;
    if (!res?.newToken || !res?.user?.bridgeUser || !res?.user?.bucket || !res?.user?.rootFolderId) {
      throw new AgentError('SERVER', 'Unexpected /users/refresh response shape', {
        details: { hasToken: !!res?.newToken },
      });
    }
    return res;
  } catch (e) {
    if (e instanceof AgentError) throw e;
    throw sanitizeToAuthError(e);
  }
}

function sanitizeToAuthError(e: unknown): AgentError {
  const err = e as Error & { response?: { status?: number }; status?: number };
  const status = err.response?.status ?? err.status;
  if (status === 401 || status === 403) {
    return new AgentError('AUTH_EXPIRED', 'Session rejected by the server (401/403). Run `inxt-agent login`.', { status });
  }
  if (status === 402) {
    return new AgentError('AUTH_EXPIRED', 'Server rejected the session (402). Unexpected for web endpoints; report this.', { status });
  }
  return new AgentError('SERVER', sanitizeMessage(err.message), { status });
}

/**
 * Run the full browser login: start the local callback server, print the URL, try to open
 * the browser, wait for the web app to hand over credentials, validate them against the API
 * and persist. Returns the stored user (redaction is the caller's job).
 */
export async function performLogin(
  config: AgentConfig,
  port: number,
  openBrowser: (url: string) => void,
): Promise<{ user: StoredUser; token: string }> {
  const cb = await startCallbackServer(config, port);
  process.stderr.write(`Open this URL in your browser to authorize inxt-agent:\n  ${cb.loginUrl}\n`);
  openBrowser(cb.loginUrl);
  try {
    const handed = await cb.wait();
    return await persistHandover(config, handed);
  } finally {
    cb.close();
  }
}

/** Validate a web-issued handover against the API and persist the session (shared by the
 *  interactive callback server and the headless paste-back flow). */
export async function persistHandover(
  config: AgentConfig,
  handed: CallbackParams,
): Promise<{ user: StoredUser; token: string }> {
  // Validate the web-issued token server-side and get the full user record.
  const fresh = await fetchFreshSession(config, handed.token);
  const token = fresh.newToken ?? handed.token;
  const user: StoredUser = {
    uuid: fresh.user.uuid,
    email: fresh.user.email,
    bridgeUser: fresh.user.bridgeUser,
    userId: fresh.user.userId,
    bucket: fresh.user.bucket,
    rootFolderId: fresh.user.rootFolderId,
    // Plain secrets come from the universal-link handover only; the API returns them encrypted.
    mnemonic: handed.mnemonic,
    keys: {
      ecc: {
        privateKey: handed.privateKey,
        publicKey: fresh.user.keys?.ecc?.publicKey ?? '',
      },
    },
  };
  await saveCredentials(config, { version: 1, savedAt: new Date().toISOString(), token, user });
  return { user, token };
}

/**
 * Headless paste-back completion: parse the pasted callback URL (never logged), validate
 * the mnemonic shape, refresh the token once via the web surface and persist.
 */
export async function completeLoginFromCallbackUrl(
  config: AgentConfig,
  pasted: string,
): Promise<{ user: StoredUser; token: string }> {
  const handed = parseCallbackUrl(pasted);
  assertMnemonicShape(handed.mnemonic);
  return persistHandover(config, handed);
}

/** Load stored credentials, or throw NOT_LOGGED_IN. */
export async function getSession(config: AgentConfig): Promise<StoredCredentials> {
  return loadCredentials(config);
}

/**
 * Single-flight token refresh: concurrent callers share one HTTP request. Uses the web
 * surface. Keeps the stored mnemonic/privateKey (the API's are encrypted); updates token
 * and user metadata. Persists the rotated token for other processes.
 */
export async function refreshSession(config: AgentConfig, creds: StoredCredentials): Promise<string> {
  const inflight = refreshInflight.get(config.dataDir);
  if (inflight) return inflight;
  const task = (async () => {
    const fresh = await fetchFreshSession(config, creds.token);
    creds.token = fresh.newToken;
    creds.user.uuid = fresh.user.uuid;
    creds.user.email = fresh.user.email;
    creds.user.bridgeUser = fresh.user.bridgeUser;
    creds.user.bucket = fresh.user.bucket;
    creds.user.rootFolderId = fresh.user.rootFolderId;
    creds.savedAt = new Date().toISOString();
    await saveCredentials(config, creds);
    return fresh.newToken;
  })();
  refreshInflight.set(config.dataDir, task);
  try {
    return await task;
  } finally {
    refreshInflight.delete(config.dataDir);
  }
}

const refreshInflight = new Map<string, Promise<string>>();

/** Log out: best-effort server-side token invalidation, then wipe local credentials. */
export async function performLogout(config: AgentConfig): Promise<void> {
  let creds: StoredCredentials | undefined;
  try {
    creds = await loadCredentials(config);
  } catch {
    return; // nothing stored; nothing to do
  }
  try {
    const auth = Auth.client(config.driveApiUrl, appDetails(config), { token: creds.token });
    await auth.logout(creds.token);
  } catch {
    // Best effort: the local credentials are discarded regardless.
  }
  await clearCredentials(config);
}
