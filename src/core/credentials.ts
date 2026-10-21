import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentError } from './errors.js';
import type { AgentConfig } from './config.js';

/**
 * Shape persisted after login (see core/login.ts). Matches what the web app hands the CLI
 * through the universal-link callback plus what /users/cli/refresh reports.
 * `mnemonic` and `keys.ecc.privateKey` are the ONLY long-lived secrets and both are required
 * to encrypt/decrypt file contents; they never leave this machine.
 */
export interface StoredUser {
  uuid: string;
  email: string;
  bridgeUser: string;
  userId: string;
  bucket: string;
  rootFolderId: string;
  mnemonic: string;
  keys: { ecc: { privateKey: string; publicKey: string } };
}

export interface StoredCredentials {
  version: 1;
  savedAt: string;
  token: string;
  user: StoredUser;
}

const MODE_FILE = 0o600;
const MODE_DIR = 0o700;

function credentialsPath(config: AgentConfig): string {
  return join(config.dataDir, 'credentials.json');
}

async function checkFilePermissions(path: string): Promise<boolean> {
  const st = await stat(path);
  // Only the owner may read/write; anything else is reported so callers can harden.
  return (st.mode & 0o077) === 0;
}

/** Persist credentials atomically with 0600 file / 0700 dir. */
export async function saveCredentials(config: AgentConfig, creds: StoredCredentials): Promise<void> {
  await mkdir(config.dataDir, { recursive: true, mode: MODE_DIR });
  const target = credentialsPath(config);
  const tmp = target + '.tmp';
  // 0600 up front so the plaintext never exists readable by group/others, not even briefly.
  await writeFile(tmp, JSON.stringify(creds, null, 2), { mode: MODE_FILE });
  await rename(tmp, target);
  await chmod(target, MODE_FILE);
}

/**
 * Load credentials or throw NOT_LOGGED_IN. Also self-checks file permissions:
 * a credentials.json readable by others is a security defect (S3 of the spec).
 */
export async function loadCredentials(config: AgentConfig): Promise<StoredCredentials> {
  const path = credentialsPath(config);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new AgentError('NOT_LOGGED_IN', 'No credentials found. Run `inxt-agent login` first.', {
      details: { path },
    });
  }
  const creds = JSON.parse(raw) as StoredCredentials;
  if (!creds?.token || !creds?.user?.mnemonic || !creds?.user?.bridgeUser) {
    throw new AgentError('NOT_LOGGED_IN', 'Stored credentials are incomplete. Run `inxt-agent login` again.', {
      details: { path },
    });
  }
  if (!(await checkFilePermissions(path))) {
    throw new AgentError(
      'PERMISSIONS',
      'credentials.json is readable by other users. Fix with: chmod 600 ' + path,
      { details: { path } },
    );
  }
  return creds;
}

export async function hasCredentials(config: AgentConfig): Promise<boolean> {
  try {
    await stat(credentialsPath(config));
    return true;
  } catch {
    return false;
  }
}

export async function clearCredentials(config: AgentConfig): Promise<void> {
  try {
    await unlink(credentialsPath(config));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** Credential fields that must never be printed. */
export const REDACTED_KEYS = new Set(['token', 'mnemonic', 'privateKey', 'bridgeUser', 'userId']);

/** Redacted view for `status` output. */
export function redactCredentials(creds: StoredCredentials): Record<string, unknown> {
  return {
    version: creds.version,
    savedAt: creds.savedAt,
    token: `<redacted:${creds.token.length} chars>`,
    user: {
      uuid: creds.user.uuid,
      email: creds.user.email,
      bridgeUser: '<redacted>',
      userId: '<redacted>',
      bucket: creds.user.bucket,
      rootFolderId: creds.user.rootFolderId,
      mnemonic: `<redacted:${creds.user.mnemonic.length} words>`,
      keys: { ecc: { privateKey: '<redacted>', publicKey: creds.user.keys.ecc.publicKey } },
    },
  };
}
