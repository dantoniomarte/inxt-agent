import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AgentError, sanitizeMessage } from './errors.js';
import type { AgentConfig } from './config.js';

/**
 * Universal-link browser login — the same flow the official CLI uses and the one this
 * account accepts (legacy SRP login is rejected for this account, verified):
 *
 *  1. Start a local HTTP server on 127.0.0.1:<port>.
 *  2. Open drive.internxt.com/login?universalLink=true&redirectUri=base64(http://127.0.0.1:port/callback)
 *  3. After the user authenticates in the browser (password / 2FA / SSO — whatever the web
 *     app requires), drive-web redirects to the callback with query params:
 *       mnemonic=<b64> newToken=<b64> privateKey=<b64>
 *     (drive-web validates the redirect target is localhost before redirecting.)
 *  4. We answer 302 to driveWebUrl/auth-link-ok, exactly like the official CLI.
 *
 * The user's password and 2FA never touch this process.
 */

export interface UniversalLinkResult {
  mnemonic: string;
  token: string;
  privateKey: string;
}

export interface CallbackServer {
  /** Port the server is listening on. */
  port: number;
  /** URL to open in the browser. */
  loginUrl: string;
  /** Resolves with the credentials handed over by the web app (once). */
  wait: () => Promise<UniversalLinkResult>;
  /** Stop the server and clear the timeout (idempotent). */
  close: () => void;
}

const CALLBACK_TIMEOUT_MS = 5 * 60_000;

function decodeParam(value: string | null, name: string): string {
  if (!value) throw new AgentError('AUTH_EXPIRED', `Login callback missing ${name}`);
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  if (decoded.length === 0) throw new AgentError('AUTH_EXPIRED', `Login callback param ${name} is empty`);
  return decoded;
}

export function buildLoginUrl(config: AgentConfig, port: number): string {
  const redirectUri = Buffer.from(`http://127.0.0.1:${port}/callback`).toString('base64');
  const params = new URLSearchParams({ universalLink: 'true', redirectUri });
  return `${config.driveWebUrl}/login?${params.toString()}`;
}

export async function startCallbackServer(config: AgentConfig, preferredPort = 0): Promise<CallbackServer> {
  let settle: (err?: AgentError, result?: UniversalLinkResult) => void;
  const done = new Promise<UniversalLinkResult>((resolve, reject) => {
    settle = (err, result) => {
      clearTimeout(timer);
      server.close();
      if (err || !result) reject(err ?? new AgentError('AUTH_EXPIRED', 'Login aborted'));
      else resolve(result);
    };
  });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) return;
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    try {
      const result: UniversalLinkResult = {
        mnemonic: decodeParam(url.searchParams.get('mnemonic'), 'mnemonic'),
        token: decodeParam(url.searchParams.get('newToken'), 'newToken'),
        privateKey: decodeParam(url.searchParams.get('privateKey'), 'privateKey'),
      };
      res.writeHead(302, { Location: `${config.driveWebUrl}/auth-link-ok` });
      res.end();
      settle(undefined, result);
    } catch (e) {
      res.writeHead(302, { Location: `${config.driveWebUrl}/auth-link-error` });
      res.end();
      settle(e instanceof AgentError ? e : new AgentError('AUTH_EXPIRED', sanitizeMessage((e as Error).message)));
    }
  });

  const timer = setTimeout(
    () => settle(new AgentError('AUTH_EXPIRED', 'Timed out waiting for browser login (5 min).')),
    CALLBACK_TIMEOUT_MS,
  );

  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => {
      clearTimeout(timer);
      server.close();
      reject(new AgentError('NETWORK', `Login callback server failed: ${sanitizeMessage(e.message)}`));
    };
    server.once('error', onError);
    server.listen(preferredPort, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const port = (server.address() as { port: number }).port;
  return {
    port,
    loginUrl: buildLoginUrl(config, port),
    wait: () => done,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}
