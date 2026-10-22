import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENTS, buildConfig, genericDescriptor, cliEntry, mcpEntry } from '../dist/cli/setup.js';

const ROOT = '/opt/inxt-agent';

test('client catalog covers the researched harnesses', () => {
  const names = Object.keys(CLIENTS);
  for (const expected of ['pi', 'claude', 'codex', 'opencode', 'openclaw', 'deepseek', 'gemini', 'cursor', 'windsurf', 'vscode']) {
    assert.ok(names.includes(expected), `missing client: ${expected}`);
  }
});

test('every client config is JSON/YAML/TOML-shaped and contains the MCP command', () => {
  for (const [name, client] of Object.entries(CLIENTS)) {
    const out = buildConfig(name, ROOT);
    assert.ok(out.config, `${name}: config missing`);
    assert.ok(['json', 'toml', 'yaml', 'shell'].includes(out.format), `${name}: bad format ${out.format}`);
    const text = typeof out.config === 'string' ? out.config : JSON.stringify(out.config);
    assert.ok(text.includes('inxt-agent-mcp.cjs'), `${name}: config must reference the launcher`);
    assert.ok(!text.includes('/home/'), `${name}: must not embed a home path when root is given`);
    assert.equal(out.command, 'node', `${name}: stdio launcher is node`);
  }
});

test('JSON-shaped clients use the shape each harness documents', () => {
  const pi = buildConfig('pi', ROOT).config;
  assert.ok(pi.mcpServers.inxt, 'pi: mcpServers.inxt');

  const claude = buildConfig('claude', ROOT).config;
  assert.ok(claude.mcpServers.inxt, 'claude: mcpServers.inxt (.mcp.json)');

  const opencode = buildConfig('opencode', ROOT).config;
  assert.equal(opencode.mcp.inxt.type, 'local', 'opencode: mcp.inxt.type=local');
  assert.ok(Array.isArray(opencode.mcp.inxt.command), 'opencode: command is an array');

  const gemini = buildConfig('gemini', ROOT).config;
  assert.ok(gemini.mcpServers.inxt, 'gemini: mcpServers.inxt');

  const vscode = buildConfig('vscode', ROOT).config;
  assert.ok(vscode.servers.inxt, 'vscode: servers.inxt');
});

test('TOML client (codex) emits a valid mcp_servers table', () => {
  const out = buildConfig('codex', ROOT);
  assert.equal(out.format, 'toml');
  assert.match(out.config, /\[mcp_servers\.inxt\]/);
  assert.match(out.config, /command = "node"/);
  assert.match(out.config, /args = \[/);
});

test('openclaw emits a CLI command (registry-style), not a config file', () => {
  const out = buildConfig('openclaw', ROOT);
  assert.equal(out.format, 'shell');
  assert.match(out.config, /^openclaw mcp add inxt /);
  assert.match(out.config, /--command node/);
});

test('deepseek harness emits a cordis patch entry with serverName', () => {
  const out = buildConfig('deepseek', ROOT);
  const text = typeof out.config === 'string' ? out.config : JSON.stringify(out.config);
  assert.ok(text.includes('dsh-mcp-client'), 'uses the official plugin');
  assert.ok(text.includes('serverName'), 'sets serverName');
});

test('generic descriptor is harness-agnostic and complete', () => {
  const d = genericDescriptor(ROOT);
  assert.equal(d.mcp.name, 'inxt');
  assert.equal(d.mcp.transport, 'stdio');
  assert.deepEqual(d.mcp.command, ['node', `${ROOT}/inxt-agent-mcp.cjs`]);
  assert.equal(d.mcp.env.INXT_AGENT_DATA_DIR, undefined, 'env only when set');
  assert.ok(d.cli.binary.endsWith('/dist/cli/index.js'));
  assert.ok(d.cli.exit_codes['2'].startsWith('auth'));
  assert.ok(Array.isArray(d.tools) && d.tools.length >= 18, 'lists every tool');
  assert.ok(d.tools.every((t) => t.name && t.description && t.destructive !== undefined));
  assert.equal(d.conventions.json_flag, '--json');
  assert.equal(d.conventions.error_stream, 'stderr');
  assert.ok(d.docs.integration.endsWith('docs/clients.md'));
});

test('cliEntry/mcpEntry resolve inside the given root', () => {
  assert.equal(cliEntry(ROOT), `${ROOT}/dist/cli/index.js`);
  assert.equal(mcpEntry(ROOT), `${ROOT}/inxt-agent-mcp.cjs`);
});

test('setup --list and the CLI surface work end to end', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const CLI = new URL('../dist/cli/index.js', import.meta.url).pathname;

  const list = JSON.parse((await run('node', [CLI, 'setup', '--list', '--json'])).stdout);
  assert.ok(list.clients.length >= 11);
  assert.ok(list.clients.every((c) => c.name && c.label && c.target));

  const codex = JSON.parse((await run('node', [CLI, 'setup', '--client', 'codex', '--json'])).stdout);
  assert.equal(codex.format, 'toml');

  const generic = JSON.parse((await run('node', [CLI, 'setup', '--generic', '--json'])).stdout);
  assert.equal(generic.schema, 'inxt-agent/integration/v1');

  // unknown client -> INVALID_ARGUMENT (exit 5)
  const err = await run('node', [CLI, 'setup', '--client', 'nope', '--json']).then(
    () => null,
    (e) => e,
  );
  assert.equal(err.code, 5);
  assert.equal(JSON.parse(err.stderr).error.code, 'INVALID_ARGUMENT');
});

test('committed docs/clients.json matches the code (no drift)', async () => {
  const { readFile } = await import('node:fs/promises');
  const { genericDescriptor, packageRoot } = await import('../dist/cli/setup.js');
  const committed = JSON.parse(await readFile(new URL('../docs/clients.json', import.meta.url), 'utf8'));
  const live = genericDescriptor(packageRoot());
  assert.deepEqual(
    committed.tools.map((t) => t.name),
    live.tools.map((t) => t.name),
    'regenerate docs/clients.json when the tool list changes',
  );
  assert.deepEqual(committed.cli.exit_codes, live.cli.exit_codes, 'exit codes must not drift');
});
