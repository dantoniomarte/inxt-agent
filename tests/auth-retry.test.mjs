import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);

const ROOT = '00000000-0000-4000-8000-000000000000';
const OLD_TOKEN = 'old-token-'.repeat(5);
const FRESH_TOKEN = 'fresh-token-'.repeat(4);

const CLI = new URL('../dist/cli/index.js', import.meta.url).pathname;

test('CLI retries once with a refreshed token on 401 and persists the rotation', async () => {
  let sawRefresh = false;
  let storageCalls = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const auth = req.headers.authorization ?? '';
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/users/refresh') {
      sawRefresh = true;
      return json(200, { newToken: FRESH_TOKEN, user: { uuid: 'u', email: 'a@b.c', userId: 'uid', bridgeUser: 'br', bucket: 'bk', rootFolderId: ROOT, keys: { ecc: { publicKey: 'pub' } } } });
    }
    if (url.pathname === `/folders/v2/content/${ROOT}/folders`) {
      storageCalls++;
      if (!sawRefresh || auth !== `Bearer ${FRESH_TOKEN}`) return json(401, { error: 'unauthorized' });
      return json(200, { folders: [{ uuid: 'aaaa0000-0000-4000-8000-000000000001', plainName: 'Finally', createdAt: null, updatedAt: null }], nextCursor: null });
    }
    if (url.pathname === `/folders/v2/content/${ROOT}/files`) return json(200, { files: [], nextCursor: null });
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dataDir = await mkdtemp(join(tmpdir(), 'inxt-retry-'));
  try {
    const creds = {
      version: 1, savedAt: new Date().toISOString(), token: OLD_TOKEN,
      user: { uuid: 'u', email: 'a@b.c', bridgeUser: 'br', userId: 'uid', bucket: 'bk', rootFolderId: ROOT, mnemonic: 'x', keys: { ecc: { privateKey: 'p', publicKey: 'pub' } } },
    };
    await writeFile(join(dataDir, 'credentials.json'), JSON.stringify(creds), { mode: 0o600 });
    const env = { ...process.env, INXT_AGENT_DATA_DIR: dataDir, INXT_DRIVE_API_URL: `http://127.0.0.1:${port}` };
    const { stdout, code } = await run('node', [CLI, 'ls', '--json'], { env }).then(
      (r) => ({ stdout: r.stdout, code: 0 }),
      (e) => ({ stdout: e.stdout ?? '', code: e.code, stderr: e.stderr }),
    );
    assert.equal(code, 0, `expected success, got ${code}`);
    const out = JSON.parse(stdout);
    assert.equal(out.items[0]?.name, 'Finally');
    assert.equal(storageCalls, 2, 'exactly one 401 then one retry');
    const persisted = JSON.parse(await readFile(join(dataDir, 'credentials.json'), 'utf8'));
    assert.equal(persisted.token, FRESH_TOKEN, 'rotated token must be persisted');
  } finally {
    server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
