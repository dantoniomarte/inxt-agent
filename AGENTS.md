# AGENTS.md

Guidance for AI agents and coding harnesses working in this repository, and for agents
that want to *use* the `inxt-agent` tools.

## What this project is

`inxt-agent` gives agents access to a user's **Internxt Drive**: list, create, upload,
download, move, rename, trash, restore, permanently delete, search, and check quota.
Transfers are end-to-end encrypted (AES-256-CTR, per-file key derived locally).

Two interfaces, one core:

| Interface | Entry point | Use when |
| --- | --- | --- |
| MCP server (stdio) | `inxt-agent-mcp.cjs` → `dist/mcp/server.js` | Your harness speaks MCP (preferred) |
| CLI | `node dist/cli/index.js <cmd> [--json]` | Your harness can run shell commands |

## Connecting (any harness)

```bash
node dist/cli/index.js setup --list                  # supported harnesses
node dist/cli/index.js setup --client <name> --json  # ready-to-paste config
node dist/cli/index.js setup --generic --json        # harness-agnostic descriptor
```

Generic contract: run `node <repo>/inxt-agent-mcp.cjs` as a stdio MCP server named
`inxt`. No arguments, no environment variables, no network listener. Credentials are
local files (`~/.config/inxt-agent/credentials.json`, mode 0600) created by a one-time
`login`.

See [docs/clients.md](docs/clients.md) for per-harness details and
[docs/clients.json](docs/clients.json) for the machine-readable manifest.

## Operating the tools safely

- **Read first.** `inxt_ls` / `inxt_search` / `inxt_quota` are read-only and cheap.
- **Confirm before destroying.** `inxt_rm` (trash), `inxt_restore`, `inxt_purge`
  (permanent), `inxt_empty_trash`, and overwriting uploads all require `confirm: true`.
  Pass it only after the human asked for that specific action.
- **`inxt_purge` and `inxt_empty_trash` are irreversible.** Prefer `inxt_rm` (trash)
  unless the human explicitly says permanent.
- **Uploads overwrite via trash.** With `confirm: true`, an existing file with the same
  name goes to the trash first; it is recoverable until the trash is emptied.
- **Never echo the headless login URL.** It contains the session handover; it is
  consumed from stdin/arguments only.

## CLI conventions (for harnesses that shell out)

- `--json` prints exactly one JSON object on **stdout**.
- Errors print one JSON object on **stderr**: `{"error":{"code","message","status?","details?"}}`.
- Exit codes are stable: `0` ok, `2` auth (run `login`), `4` not-found/exists,
  `5` invalid argument, `6` quota, `7` rate-limited, `8` network, `9` aborted,
  `10` crypto, `11` local permissions, `12` confirmation required, `13` server.
- Destructive commands need `--yes`.

## Working *on* this repository

```bash
npm install
npm run build
npm test                      # 46 unit tests, fake HTTP servers only (never a real account)
bash scripts/e2e-sandbox.sh   # E2E against a real account, inside a disposable sandbox
```

Rules:

- Keep the JSON contract and exit codes stable; they are the public API for agents.
- Add or change a command → update `--help`, `README.md`, and `docs/clients.md`.
- Never commit credentials, tokens, mnemonics, or account identifiers.
- Destructive behavior must stay double-gated (`confirm:true` / `--yes`).

## Architecture

```
src/core/       config, errors, credential store, auth (universal-link + headless
                paste-back + single-flight refresh), drive repo (pagination, cache)
src/transfer/   E2EE engine (streaming uploads, AES-256-CTR downloads)
src/cli/        JSON contract, exit codes, `setup` client catalog
src/mcp/        stdio MCP server (18 tools, annotated)
```
