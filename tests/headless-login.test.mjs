import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

import { parseCallbackUrl } from '../dist/core/headless.js';
import { completeLoginFromCallbackUrl } from '../dist/core/auth.js';
import { AgentError } from '../dist/core/errors.js';

const B64 = (s) => Buffer.from(s).toString('base64');
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CB = (extra = '') => `http://127.0.0.1:49152/callback?mnemonic=${B64('words-here')}&newToken=${B64('jwt-here')}&privateKey=${B64('priv-here')}${extra}`;

test('parseCallbackUrl extracts and decodes the three params', () => {
  const r = parseCallbackUrl(CB());
  assert.deepEqual(r, { mnemonic: 'words-here', token: 'jwt-here', privateKey: 'priv-here' });
});

test('parseCallbackUrl accepts URL-encoded values and a redirectUri that needed unescaping', () => {
  const u = CB().replace('mnemonic=' + B64('words-here'), 'mnemonic=' + encodeURIComponent(B64('words-here')));
  assert.equal(parseCallbackUrl(u).mnemonic, 'words-here');
});

test('parseCallbackUrl rejects garbage, missing params, empty values', () => {
  assert.throws(() => parseCallbackUrl('not a url'), AgentError);
  assert.throws(() => parseCallbackUrl('http://127.0.0.1:1/callback?mnemonic=' + B64('a')), AgentError);
  assert.throws(() => parseCallbackUrl('http://127.0.0.1:1/callback?mnemonic=&newToken=' + B64('t') + '&privateKey=' + B64('p')), AgentError);
});

test('completeLoginFromCallbackUrl: validates mnemonic, refreshes via /users/refresh, saves 0600', async () => {
  let refreshCalls = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/users/refresh') {
      refreshCalls++;
      if (req.headers.authorization !== 'Bearer jwt-here') { res.writeHead(401).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ newToken: 'fresh-jwt', user: { uuid: 'u1', email: 'v@w.x', userId: 'uid', bridgeUser: 'br', bucket: 'bk', rootFolderId: 'root-1', keys: { ecc: { publicKey: 'pub' } } } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'inxt-hl-'));
  const config = { dataDir: dir, driveApiUrl: `http://127.0.0.1:${port}` };
  try {
    // invalid mnemonic shape is rejected BEFORE any network call
    await assert.rejects(
      () => completeLoginFromCallbackUrl(config, CB()),
      (e) => e instanceof AgentError && e.code === 'AUTH_EXPIRED',
    );
    // now with a REAL (test-vector) mnemonic
    const url = `http://127.0.0.1:1/callback?mnemonic=${B64(MNEMONIC)}&newToken=${B64('jwt-here')}&privateKey=${B64('priv-here')}`;
    const { user } = await completeLoginFromCallbackUrl(config, url);
    assert.equal(user.email, 'v@w.x');
    assert.equal(user.bucket, 'bk');
    assert.equal(refreshCalls, 1, 'exactly one refresh call');
    const path = join(dir, 'credentials.json');
    const st = await stat(path);
    assert.equal(st.mode & 0o077, 0, 'file must be 0600');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.token, 'fresh-jwt', 'rotated token persisted');
    assert.equal(saved.user.mnemonic, MNEMONIC);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI login --remote consumes the pasted URL from stdin and persists the session', async () => {
  let refreshCalls = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/users/refresh') {
      refreshCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ newToken: 'fresh-jwt', user: { uuid: 'u1', email: 'v@w.x', userId: 'uid', bridgeUser: 'br', bucket: 'bk', rootFolderId: 'root-1', keys: { ecc: { publicKey: 'pub' } } } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'inxt-hlcli-'));
  const CLI = new URL('../dist/cli/index.js', import.meta.url).pathname;
  const env = { ...process.env, INXT_AGENT_DATA_DIR: dir, INXT_DRIVE_API_URL: `http://127.0.0.1:${port}` };
  try {
    const cbUrl = `http://127.0.0.1:1/callback?mnemonic=${B64(MNEMONIC)}&newToken=${B64('jwt-here')}&privateKey=${B64('priv-here')}`;
    const child = spawn('node', [CLI, 'login', '--remote', '--json'], { env });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    // Wait for the URL prompt line, then feed the callback URL on stdin
    await new Promise((r) => setTimeout(r, 800));
    child.stdin.write(cbUrl + '\n');
    const code = await new Promise((r) => child.on('exit', r));
    const out = Buffer.concat(chunks).toString();
    assert.equal(code, 0, `exit 0 expected; output: ${out.slice(0, 400)}`);
    assert.ok(out.includes('"loggedIn":true'), 'JSON success on stdout');
    assert.ok(!out.includes(cbUrl), 'pasted callback URL must NOT be echoed back');
    const saved = JSON.parse(await readFile(join(dir, 'credentials.json'), 'utf8'));
    assert.equal(saved.token, 'fresh-jwt');
    assert.equal(refreshCalls, 1);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
