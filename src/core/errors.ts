/**
 * Error taxonomy for agents: every failure maps to a stable `code`, a human message and
 * (for CLI) an exit code. Codes are part of the public contract — do not rename.
 */

export type AgentErrorCode =
  | 'NOT_LOGGED_IN' // no credentials on disk -> run login
  | 'AUTH_EXPIRED' // refresh failed; re-run login
  | 'PATH_NOT_FOUND' // remote path does not exist
  | 'ALREADY_EXISTS' // create/rename collision
  | 'AMBIGUOUS_PATH' // multiple children with the same name
  | 'INVALID_ARGUMENT'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'ABORTED'
  | 'CRYPTO'
  | 'PERMISSIONS'
  | 'CONFIRMATION_REQUIRED' // destructive op without --yes / confirm flag
  | 'SERVER'
  | 'UNKNOWN';

const EXIT_CODES: Record<AgentErrorCode, number> = {
  NOT_LOGGED_IN: 2,
  AUTH_EXPIRED: 2,
  PATH_NOT_FOUND: 4,
  ALREADY_EXISTS: 4,
  AMBIGUOUS_PATH: 4,
  INVALID_ARGUMENT: 5,
  QUOTA_EXCEEDED: 6,
  RATE_LIMITED: 7,
  NETWORK: 8,
  ABORTED: 9,
  CRYPTO: 10,
  PERMISSIONS: 11,
  CONFIRMATION_REQUIRED: 12,
  SERVER: 13,
  UNKNOWN: 1,
};

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(code: AgentErrorCode, message: string, opts?: { status?: number; details?: Record<string, unknown> }) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.status = opts?.status;
    this.details = opts?.details;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }

  /** JSON-safe payload for the CLI/MCP contract. Never includes credentials. */
  toJSON(): Record<string, unknown> {
    return {
      error: { code: this.code, message: this.message, status: this.status, details: this.details },
    };
  }
}

export function isAgentError(e: unknown): e is AgentError {
  return e instanceof AgentError;
}

/** Map any thrown value to an AgentError, best effort, without leaking secrets. */
export function toAgentError(e: unknown): AgentError {
  if (isAgentError(e)) return e;
  if (e instanceof Error) {
    const anyE = e as Error & { status?: number; response?: { status?: number }; code?: string };
    const status = anyE.response?.status ?? anyE.status;
    const msg = sanitizeMessage(e.message);
    if (status === 401 || status === 403) return new AgentError('AUTH_EXPIRED', msg, { status });
    if (status === 404) return new AgentError('PATH_NOT_FOUND', msg, { status });
    if (status === 409) return new AgentError('ALREADY_EXISTS', msg, { status });
    if (status === 429) return new AgentError('RATE_LIMITED', msg, { status });
    if (status !== undefined && status >= 500) return new AgentError('SERVER', msg, { status });
    if (anyE.code === 'ECONNREFUSED' || anyE.code === 'ETIMEDOUT' || anyE.code === 'ENOTFOUND') {
      return new AgentError('NETWORK', msg, { details: { sysCode: anyE.code } });
    }
    return new AgentError('UNKNOWN', msg);
  }
  return new AgentError('UNKNOWN', 'Unexpected error');
}

/** Strip anything that looks like a token/mnemonic from error messages. */
export function sanitizeMessage(msg: string): string {
  return msg
    .replace(/[A-Za-z0-9+/=]{32,}/g, '<redacted>')
    .replace(/abandon [a-z]+ (about|across)[a-z ]+/gi, '<redacted-mnemonic>');
}
