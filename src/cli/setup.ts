import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Client integration catalog.
 *
 * Each entry knows the config shape its harness documents, so `inxt-agent setup` can print a
 * ready-to-paste snippet instead of prose. Sources (verified against official docs):
 *
 *  - pi          ~/.pi/agent/mcp.json      { "mcpServers": { name: { command, args } } }
 *  - claude      .mcp.json (project scope) { "mcpServers": { name: { command, args } } }
 *  - codex       ~/.codex/config.toml      [mcp_servers.<id>] command/args/env
 *  - opencode    opencode.json             { "mcp": { name: { type: "local", command: [...] } } }
 *  - openclaw    registry CLI              `openclaw mcp add <name> --command ... --arg ...`
 *  - deepseek    cordis.patch.yml          plugin entry: @deepseek-ai/dsh-mcp-client
 *  - gemini      ~/.gemini/settings.json   { "mcpServers": { name: { command, args } } }
 *  - cursor      .cursor/mcp.json          { "mcpServers": { name: { command, args } } }
 *  - windsurf    ~/.codeium/windsurf/mcp_config.json  same mcpServers shape
 *  - vscode      .vscode/mcp.json          { "servers": { name: { type: "stdio", command, args } } }
 *  - generic     harness-agnostic descriptor (see genericDescriptor)
 */

export type ConfigFormat = 'json' | 'toml' | 'yaml' | 'shell';

export interface ClientSpec {
  /** Human label shown by `setup --list`. */
  label: string;
  /** Where the snippet belongs. */
  target: string;
  /** Snippet language. */
  format: ConfigFormat;
  /** True when the harness reads the file from the project (committable) rather than home. */
  projectScoped: boolean;
  /** Extra notes printed with the snippet. */
  notes?: string[];
}

export interface BuiltConfig {
  client: string;
  label: string;
  target: string;
  format: ConfigFormat;
  projectScoped: boolean;
  command: string;
  args: string[];
  config: unknown;
  notes: string[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository/dist root: dist/cli/setup.js -> <root>. */
export function packageRoot(): string {
  return resolve(HERE, '..', '..');
}

export function cliEntry(root: string): string {
  return `${root}/dist/cli/index.js`;
}

export function mcpEntry(root: string): string {
  return `${root}/inxt-agent-mcp.cjs`;
}

/** Minimal stdio MCP server descriptor shared by every JSON-shaped client. */
function stdio(root: string): { command: string; args: string[] } {
  return { command: 'node', args: [mcpEntry(root)] };
}

export const CLIENTS: Record<string, ClientSpec> = {
  pi: {
    label: 'pi (Gentle AI)',
    target: '~/.pi/agent/mcp.json  (or .pi/mcp.json for a trusted project)',
    format: 'json',
    projectScoped: false,
    notes: ['Register with `pi mcp add inxt -- node <repo>/inxt-agent-mcp.cjs`, or merge this block.'],
  },
  claude: {
    label: 'Claude Code',
    target: '.mcp.json (project scope) or ~/.claude.json',
    format: 'json',
    projectScoped: true,
    notes: ['Equivalent CLI: `claude mcp add --scope project inxt -- node <repo>/inxt-agent-mcp.cjs`.'],
  },
  codex: {
    label: 'Codex CLI',
    target: '~/.codex/config.toml (or .codex/config.toml per project)',
    format: 'toml',
    projectScoped: false,
  },
  opencode: {
    label: 'OpenCode',
    target: 'opencode.json (project) or ~/.config/opencode/opencode.json',
    format: 'json',
    projectScoped: true,
  },
  openclaw: {
    label: 'OpenClaw',
    target: 'OpenClaw MCP registry (run the command with the Gateway stopped)',
    format: 'shell',
    projectScoped: false,
    notes: ['Verify afterwards with `openclaw mcp doctor inxt --probe`.'],
  },
  deepseek: {
    label: 'DeepSeek Harness (dsh)',
    target: 'cordis.patch.yml (profile patch layer)',
    format: 'yaml',
    projectScoped: false,
    notes: ['Tool names surface as mcp__inxt__<tool>. Resources/Prompts are not bridged by dsh.'],
  },
  gemini: {
    label: 'Gemini CLI',
    target: '~/.gemini/settings.json (or .gemini/settings.json)',
    format: 'json',
    projectScoped: false,
  },
  cursor: {
    label: 'Cursor',
    target: '.cursor/mcp.json (project) or ~/.cursor/mcp.json',
    format: 'json',
    projectScoped: true,
  },
  windsurf: {
    label: 'Windsurf',
    target: '~/.codeium/windsurf/mcp_config.json',
    format: 'json',
    projectScoped: false,
  },
  vscode: {
    label: 'VS Code (Copilot agent mode)',
    target: '.vscode/mcp.json (project)',
    format: 'json',
    projectScoped: true,
  },
  generic: {
    label: 'Generic (any other agent / harness)',
    target: 'stdout — harness-agnostic descriptor',
    format: 'json',
    projectScoped: false,
    notes: ['See docs/clients.md and docs/clients.json for the integration contract.'],
  },
};

export function buildConfig(name: string, root: string): BuiltConfig {
  const spec = CLIENTS[name];
  if (!spec) {
    throw new Error(`Unknown client "${name}". Known: ${Object.keys(CLIENTS).join(', ')}`);
  }
  const base = { client: name, label: spec.label, target: spec.target, format: spec.format, projectScoped: spec.projectScoped, command: 'node', args: [mcpEntry(root)], notes: spec.notes ?? [] };

  switch (name) {
    case 'pi':
    case 'claude':
    case 'gemini':
    case 'cursor':
    case 'windsurf':
      return { ...base, config: { mcpServers: { inxt: stdio(root) } } };

    case 'opencode':
      return {
        ...base,
        config: { $schema: 'https://opencode.ai/config.json', mcp: { inxt: { type: 'local', command: ['node', mcpEntry(root)], enabled: true } } },
      };

    case 'vscode':
      return { ...base, config: { servers: { inxt: { type: 'stdio', ...stdio(root) } } } };

    case 'codex':
      return {
        ...base,
        config: [
          '[mcp_servers.inxt]',
          'command = "node"',
          `args = ["${mcpEntry(root)}"]`,
          '# env = { INXT_AGENT_DATA_DIR = "/custom/data/dir" }  # optional',
          'startup_timeout_sec = 20',
          'tool_timeout_sec = 120',
        ].join('\n'),
      };

    case 'openclaw':
      return {
        ...base,
        config: `openclaw mcp add inxt --command node --arg ${mcpEntry(root)} --approval auto`,
      };

    case 'deepseek':
      return {
        ...base,
        config: [
          '- id: mcp-inxt',
          "  name: '@deepseek-ai/dsh-mcp-client'",
          '  config:',
          '    serverName: inxt',
          '    transport: stdio',
          '    command: node',
          `    args: ['${mcpEntry(root)}']`,
        ].join('\n'),
      };

    case 'generic':
      return { ...base, config: genericDescriptor(root) };

    default:
      throw new Error(`No builder for client "${name}"`);
  }
}

/** Every tool the MCP server exposes, for harness-agnostic discovery. */
export const TOOL_NAMES: Array<{ name: string; description: string; destructive: boolean; readOnly: boolean }> = [
  { name: 'inxt_status', description: 'Session state (redacted) and storage quota', readOnly: true, destructive: false },
  { name: 'inxt_login', description: 'Authorize via browser (universal-link); opens a URL for the human', readOnly: false, destructive: false },
  { name: 'inxt_login_remote', description: 'Headless step 1: return the authorization URL', readOnly: true, destructive: false },
  { name: 'inxt_login_complete', description: 'Headless step 2: finish with the pasted callback URL', readOnly: false, destructive: false },
  { name: 'inxt_logout', description: 'Invalidate the session and wipe local credentials', readOnly: false, destructive: false },
  { name: 'inxt_ls', description: 'List a folder or stat a file', readOnly: true, destructive: false },
  { name: 'inxt_search', description: 'Server-side fuzzy search by name', readOnly: true, destructive: false },
  { name: 'inxt_quota', description: 'Account usage and limits', readOnly: true, destructive: false },
  { name: 'inxt_mkdir', description: 'Create a folder recursively', readOnly: false, destructive: false },
  { name: 'inxt_upload', description: 'Upload a local file (E2EE); confirm:true to overwrite', readOnly: false, destructive: false },
  { name: 'inxt_download', description: 'Download and decrypt a file', readOnly: false, destructive: false },
  { name: 'inxt_mv', description: 'Move and/or rename', readOnly: false, destructive: false },
  { name: 'inxt_rename', description: 'Rename in place', readOnly: false, destructive: false },
  { name: 'inxt_rm', description: 'Move to trash (recoverable); confirm:true', readOnly: false, destructive: true },
  { name: 'inxt_trash_list', description: 'List trashed items', readOnly: true, destructive: false },
  { name: 'inxt_restore', description: 'Restore a trashed item; confirm:true', readOnly: false, destructive: false },
  { name: 'inxt_purge', description: 'Permanently delete a trashed item; confirm:true (IRREVERSIBLE)', readOnly: false, destructive: true },
  { name: 'inxt_empty_trash', description: 'Empty the whole trash; confirm:true (IRREVERSIBLE)', readOnly: false, destructive: true },
];

/**
 * Harness-agnostic integration descriptor: everything an agent runtime (or a human writing
 * glue code) needs, with no assumption about any particular harness.
 */
export function genericDescriptor(root: string): Record<string, unknown> {
  return {
    schema: 'inxt-agent/integration/v1',
    name: 'inxt-agent',
    version: '0.3.0',
    summary: 'Agent access to Internxt Drive: E2EE transfers, CLI, and MCP server.',
    mcp: {
      name: 'inxt',
      transport: 'stdio',
      command: ['node', mcpEntry(root)],
      protocol: 'modelcontextprotocol',
      // stdio MCP has no auth handshake: credentials are local files at 0600.
      auth: 'local-credentials',
      env: {},
    },
    cli: {
      binary: cliEntry(root),
      invoke: `node ${cliEntry(root)} <command> [args] [--json]`,
      json_flag: '--json',
      exit_codes: {
        '0': 'ok',
        '2': 'auth required (run login)',
        '4': 'path not found / already exists',
        '5': 'invalid argument',
        '6': 'quota exceeded',
        '7': 'rate limited',
        '8': 'network error',
        '9': 'aborted',
        '10': 'crypto error',
        '11': 'local permissions',
        '12': 'confirmation required (--yes)',
        '13': 'server error',
      },
    },
    tools: TOOL_NAMES,
    conventions: {
      json_flag: '--json',
      error_stream: 'stderr',
      error_shape: '{ "error": { "code", "message", "status?", "details?" } }',
      destructive_gate: 'confirm:true (MCP) / --yes (CLI)',
    },
    docs: {
      integration: `${root}/docs/clients.md`,
      manifest: `${root}/docs/clients.json`,
      readme: `${root}/README.md`,
      agents: `${root}/AGENTS.md`,
    },
  };
}

export function listClients(): Array<{ name: string; label: string; target: string; format: ConfigFormat; projectScoped: boolean }> {
  return Object.entries(CLIENTS).map(([name, spec]) => ({
    name,
    label: spec.label,
    target: spec.target,
    format: spec.format,
    projectScoped: spec.projectScoped,
  }));
}
