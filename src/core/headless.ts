import { validateMnemonic } from 'bip39';
import { AgentError } from './errors.js';

/**
 * Headless (paste-back) login support.
 *
 * Internxt exposes no device-code flow, and drive-web hard-validates the universal-link
 * redirect target to exactly http://127.0.0.1 — so a headless machine cannot receive the
 * callback directly. Two sanctioned patterns (same as rclone remote_setup / Claude Code):
 *
 *   A) SSH tunnel: run `login --port N`, forward it (`ssh -L N:127.0.0.1:N user@vps`),
 *      open the printed URL in the LOCAL browser; the redirect reaches the VPS server
 *      through the tunnel and the flow completes automatically.
 *   B) Pure paste (`login --remote`): the printed login URL uses a throwaway redirect
 *      (http://127.0.0.1:1/callback). After login the browser fails to connect, but the
 *      full callback URL (mnemonic/newToken/privateKey) is sitting in the address bar:
 *      the user pastes it back and the session completes here.
 */

export interface CallbackParams {
  mnemonic: string;
  token: string;
  privateKey: string;
}

const REQUIRED = ['mnemonic', 'newToken', 'privateKey'] as const;

function decodeParam(value: string | null, name: string): string {
  if (!value) throw new AgentError('AUTH_EXPIRED', `Pasted login URL is missing "${name}"`);
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  if (decoded.length === 0) throw new AgentError('AUTH_EXPIRED', `Pasted login URL has an empty "${name}"`);
  return decoded;
}

/**
 * Parse a pasted callback URL (or a bare `mnemonic=...&newToken=...&privateKey=...` query).
 * Throws AUTH_EXPIRED with an actionable message on anything malformed. Never logs the
 * input: the pasted string IS the credential set.
 */
export function parseCallbackUrl(pasted: string): CallbackParams {
  const raw = pasted.trim();
  if (raw.length === 0) throw new AgentError('AUTH_EXPIRED', 'Nothing was pasted');
  let query: URLSearchParams;
  try {
    // Accept full callback URLs; tolerate unescaped special chars in the query part.
    const withBase = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://127.0.0.1/callback?${raw}`;
    query = new URL(withBase).searchParams;
  } catch {
    throw new AgentError('AUTH_EXPIRED', 'Pasted login data is not a valid URL. Copy the full URL from the browser address bar.');
  }
  return {
    mnemonic: decodeParam(query.get('mnemonic'), 'mnemonic'),
    token: decodeParam(query.get('newToken'), 'newToken'),
    privateKey: decodeParam(query.get('privateKey'), 'privateKey'),
  };
}

/** Shape-level validation of the handed-over mnemonic (cheap, before any network call). */
export function assertMnemonicShape(mnemonic: string): void {
  if (!/^[a-z]+(\s[a-z]+){11,31}$/.test(mnemonic)) {
    throw new AgentError('AUTH_EXPIRED', 'Pasted login data failed the mnemonic shape check. Copy the URL again from the browser.');
  }
  try {
    if (!validateMnemonic(mnemonic)) {
      throw new AgentError('AUTH_EXPIRED', 'Pasted login data contains an invalid mnemonic (checksum failed). Log in again and copy the URL.');
    }
  } catch (e) {
    if (e instanceof AgentError) throw e;
    // bip39 throws on wrong word counts / unknown words
    throw new AgentError('AUTH_EXPIRED', 'Pasted login data contains an invalid mnemonic. Log in again and copy the URL.');
  }
}
