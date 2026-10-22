# Client integration

`inxt-agent` exposes one stdio MCP server (name `inxt`, 18 tools) and one JSON CLI.
Any MCP-capable harness works with the generic form:

```json
{ "command": "node", "args": ["/absolute/path/to/inxt-agent-mcp.cjs"] }
```

Print a ready-to-paste snippet for a specific harness:

```bash
node dist/cli/index.js setup --list                  # table of supported clients
node dist/cli/index.js setup --client codex --json   # config + target path + notes
node dist/cli/index.js setup --generic --json        # harness-agnostic descriptor
```

## Supported harnesses

| Client | Config location | Shape | Project-scoped |
| --- | --- | --- | --- |
| `pi` | `~/.pi/agent/mcp.json` or `.pi/mcp.json` | `mcpServers.inxt` | optional |
| `claude` | `.mcp.json` (project) or `~/.claude.json` | `mcpServers.inxt` | yes |
| `codex` | `~/.codex/config.toml` or `.codex/config.toml` | `[mcp_servers.inxt]` | optional |
| `opencode` | `opencode.json` or `~/.config/opencode/opencode.json` | `mcp.inxt.type=local`, `command` array | yes |
| `openclaw` | OpenClaw MCP registry (CLI) | `openclaw mcp add inxt …` | no |
| `deepseek` | `cordis.patch.yml` | `@deepseek-ai/dsh-mcp-client` plugin entry | no |
| `gemini` | `~/.gemini/settings.json` | `mcpServers.inxt` | optional |
| `cursor` | `.cursor/mcp.json` or `~/.cursor/mcp.json` | `mcpServers.inxt` | yes |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | `mcpServers.inxt` | no |
| `vscode` | `.vscode/mcp.json` | `servers.inxt.type=stdio` | yes |
| `generic` | — | descriptor on stdout | — |

## Per-harness notes

### pi

```bash
pi mcp add inxt -- node /absolute/path/to/inxt-agent-mcp.cjs
pi mcp list          # expect: inxt: connected, 18 tools
```

### [CC]

```bash
claude mcp add --scope project inxt -- node /absolute/path/to/inxt-agent-mcp.cjs
```

`.mcp.json` is committed with the team and read at session start; changes require a restart.

### Codex CLI

```toml
[mcp_servers.inxt]
command = "node"
args = ["/absolute/path/to/inxt-agent-mcp.cjs"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

Per-tool approvals: `mcp_servers.inxt.default_tools_approval_mode = "auto"` honours the
tools' `destructiveHint` annotations.

### OpenCode

```json
{ "$schema": "https://opencode.ai/config.json",
  "mcp": { "inxt": { "type": "local", "command": ["node", "/abs/inxt-agent-mcp.cjs"], "enabled": true } } }
```

`command` is an array in OpenCode, unlike most other harnesses.

### OpenClaw

```bash
openclaw mcp add inxt --command node --arg /abs/inxt-agent-mcp.cjs --approval auto
openclaw mcp doctor inxt --probe
```

The registry write requires the Gateway to be stopped.

### DeepSeek Harness (dsh)

```yaml
- id: mcp-inxt
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: inxt
    transport: stdio
    command: node
    args: ['/abs/inxt-agent-mcp.cjs']
```

Tools surface as `mcp__inxt__<tool>`. dsh bridges Tools only (not Resources/Prompts) and
hot-reloads on config edits.

### Gemini CLI, Cursor, Windsurf

All three use the `mcpServers` map:

```json
{ "mcpServers": { "inxt": { "command": "node", "args": ["/abs/inxt-agent-mcp.cjs"] } } }
```

### VS Code (Copilot agent mode)

```json
{ "servers": { "inxt": { "type": "stdio", "command": "node", "args": ["/abs/inxt-agent-mcp.cjs"] } } }
```

## Anything else

If your harness can spawn a stdio process and speak MCP, it works. Consume
[`docs/clients.json`](clients.json) — a harness-agnostic descriptor with the command,
every tool (name, description, read-only/destructive), the CLI contract, and the error
and exit-code taxonomy — and map it to whatever your harness expects.

Minimal generic integration:

1. Spawn `node /abs/inxt-agent-mcp.cjs`.
2. Speak MCP over stdin/stdout (`initialize`, `tools/list`, `tools/call`).
3. Pass `confirm: true` only for destructive tools the human approved.
4. If your harness cannot speak MCP, shell out instead: `node dist/cli/index.js <cmd> --json`
   and branch on exit codes.

## Authentication (all harnesses)

One-time, per machine:

```bash
node dist/cli/index.js login             # browser on this machine
node dist/cli/index.js login --remote    # headless: open the URL elsewhere, paste it back
node dist/cli/index.js login --port N    # headless: ssh -L N:127.0.0.1:N user@host
```

Credentials live at `~/.config/inxt-agent/credentials.json` (0600, dir 0700). The MCP
server never prompts: if the session is missing, tools return `NOT_LOGGED_IN` and the
human runs `login`.
