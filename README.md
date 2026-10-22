# inxt-agent

[![CI](https://github.com/dantoniomarte/inxt-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/dantoniomarte/inxt-agent/actions/workflows/ci.yml)

Agent access to your **Internxt Drive** from pi, hermes, Claude, or any MCP client.
End-to-end encrypted transfers, a stable JSON CLI contract, and an 18-tool MCP
server — with no desktop app, no official CLI, and no rclone.

## Features

- **Browser login, zero secrets handled** — you authorize once in your browser
  (password and 2FA never leave it); the agent receives only the web-issued
  session handover.
- **Headless-friendly** — works on VPS machines with no browser: paste-back mode
  or an SSH tunnel for a fully automatic flow.
- **End-to-end encrypted transfers** — streaming uploads (multipart, presigned
  S3) and downloads with AES-256-CTR; key derivation is byte-identical to
  Internxt's web client and was verified byte-for-byte against a real account.
- **Agent-native contract** — one JSON object on stdout, structured errors on
  stderr with stable codes, stable exit codes, destructive operations double-gated.
- **18 MCP tools, any harness** — pi, [CC], Codex, OpenCode, OpenClaw, DeepSeek Harness, Gemini, Cursor, Windsurf, VS Code, or anything that speaks MCP — annotated (`readOnlyHint` / `destructiveHint`), with
  `confirm: true` required for anything irreversible.
- **Resilient by default** — single-flight token rotation on 401, SDK backoff on
  rate limits, cursor pagination, TTL-cached path resolution.

## Why not rclone or the official CLI?

Internxt's legacy login (email + password, used by rclone and
`internxt login-legacy`) is tier-gated: the API answers
`402 — "This user current tier does not allow CLI access"` on CLI-surface
endpoints. The **web surface has no such gate** — it is what drive.internxt.com
uses. `inxt-agent` speaks only that surface, so it works with any tier the web
app works with, and never performs the legacy password login at all.

## Requirements

- Node.js >= 22.13
- An Internxt account (any tier the web app works with)

## Quick start

```bash
npm install && npm run build
node dist/cli/index.js login          # authorize once in your browser
node dist/cli/index.js ls --json      # list your Drive
```

Credentials persist at `~/.config/inxt-agent/credentials.json` (mode `0600`,
inside a `0700` directory, atomic writes). `status` shows them redacted.

## Authentication

### Browser (same machine)

`login` starts a local callback server and opens the Internxt login page
(universal-link flow). Approve once; the session is persisted and tokens are
rotated automatically afterwards.

### Headless A — paste-back (no tunnel needed)

```bash
inxt-agent login --remote
# 1. Open the printed URL on ANY machine with a browser and log in.
# 2. The browser "fails to connect" (127.0.0.1:1 refused) — that is expected.
# 3. Copy the FULL URL from the address bar and paste it into the prompt.
```

The pasted URL carries the credential set: it is read from stdin only (never
argv), never echoed, never logged, and the mnemonic is validated before any
network call.

### Headless B — SSH tunnel (fully automatic)

```bash
inxt-agent login --port 49152
# On YOUR machine:   ssh -L 49152:127.0.0.1:49152 user@vps
# Then open the printed URL in the local browser: the redirect reaches the VPS
# callback server through the tunnel and the login completes by itself.
```

## CLI

One JSON object on stdout (with `--json`); errors go to stderr as one JSON
object with a stable `error.code`. Exit codes are stable: `0` ok · `2` auth ·
`4` not-found/exists · `5` invalid-argument · `6` quota · `7` rate-limited ·
`8` network · `9` aborted · `10` crypto · `11` local permissions ·
`12` confirmation-required · `13` server.

```bash
inxt-agent status                       # session + quota (redacted)
inxt-agent ls [path]                    # list a folder / stat a file
inxt-agent search <term>                # server-side fuzzy search
inxt-agent quota
inxt-agent mkdir <path>                 # recursive, like mkdir -p
inxt-agent cp <local> <remote> [--yes]  # upload (--yes overwrites via trash)
inxt-agent get <remote> <local>         # download + decrypt
inxt-agent mv <src> <dest>              # move and/or rename
inxt-agent rename <path> <name>
inxt-agent rm <path> --yes              # to trash (recoverable)
inxt-agent trash [restore <name> --yes]
inxt-agent purge <name> --yes           # permanent (IRREVERSIBLE)
inxt-agent emptytrash --yes             # permanent (IRREVERSIBLE)
inxt-agent logout
```

Example:

```console
$ inxt-agent ls Reports --json
{"path":"Reports","items":[
  {"kind":"folder","name":"2025","uuid":"…","updatedAt":"2026-01-12T10:00:00.000Z"},
  {"kind":"file","name":"q3.pdf","uuid":"…","size":48213,"updatedAt":"2026-02-03T09:30:00.000Z"}
]}
```

## Use it from any agent

One stdio MCP server (`inxt`, 18 tools) and one JSON CLI. Print the exact config for your
harness — no docs reading required:

```bash
node dist/cli/index.js setup --list                  # supported harnesses
node dist/cli/index.js setup --client codex --json   # ready-to-paste config + target path
node dist/cli/index.js setup --generic --json        # harness-agnostic descriptor
```

| Harness | One-liner |
| --- | --- |
| pi | `pi mcp add inxt -- node /abs/inxt-agent-mcp.cjs` |
| [CC] | `claude mcp add --scope project inxt -- node /abs/inxt-agent-mcp.cjs` |
| Codex CLI | `[mcp_servers.inxt]` in `~/.codex/config.toml` |
| OpenCode | `mcp.inxt` in `opencode.json` (command is an array) |
| OpenClaw | `openclaw mcp add inxt --command node --arg /abs/inxt-agent-mcp.cjs` |
| DeepSeek Harness | `@deepseek-ai/dsh-mcp-client` entry in `cordis.patch.yml` |
| Gemini CLI · Cursor · Windsurf | `mcpServers.inxt` in their settings file |
| VS Code | `servers.inxt` in `.vscode/mcp.json` |
| anything else | spawn `node /abs/inxt-agent-mcp.cjs`, speak MCP over stdio |

Full matrix and per-harness notes: [docs/clients.md](docs/clients.md). Machine-readable
manifest for tooling: [docs/clients.json](docs/clients.json). Repo conventions for agents:
[AGENTS.md](AGENTS.md).

Irreversible tools are annotated `destructiveHint: true` **and** require `confirm: true`.
Token expiry is handled automatically (one refresh + retry); a dead session surfaces as
`AUTH_EXPIRED`.

## How it works

```
src/core/       config, error taxonomy, credential store, auth
                (universal-link + headless paste-back + single-flight refresh),
                drive repo (cursor pagination, TTL cache, path resolution)
src/transfer/   E2EE engine: streaming uploads, downloads
                (bridge getDownloadLinks -> S3 shards -> AES-256-CTR),
                key derivation replicated from Internxt's web client
src/cli/        JSON contract + stable exit codes
src/mcp/        stdio MCP server (official SDK)
```

Only web-surface endpoints are used (`/users/refresh`, `/folders/v2/*`,
`/storage/trash/*`, `/fuzzy/*`, `/users/usage`) — never the tier-gated CLI
surface.

## Development

```bash
npm test                        # 48 unit tests on fake HTTP servers
bash scripts/e2e-sandbox.sh     # E2E round-trip against a REAL account,
                                # inside a disposable sandbox folder (leaves it clean)
```

## Security notes

- Credentials live locally at `0600` (`0700` dir); writes are atomic; loads
  self-check permissions and fail closed on anything laxer.
- Nothing secret is ever printed: `status` redacts, errors sanitize
  token-shaped strings, the headless paste is consumed from stdin without echo.
- Destructive operations are double-gated: CLI `--yes` / MCP `confirm:true`,
  plus destructive annotations for MCP clients.
- The account's mnemonic never leaves the machine; only file *ciphertext*
  travels, and keys are derived locally per file.

## Disclaimer

This is an independent, unofficial tool. Not affiliated with, endorsed by, or
sponsored by Internxt. "Internxt" is a trademark of its respective owner, used
here solely for identification.

## License

[MIT](LICENSE)
