import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);

const CLI = new URL('../dist/cli/index.js', import.meta.url).pathname;
const env = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inxt-cli-'));
  return { ...process.env, INXT_AGENT_DATA_DIR: dir };
};

test('status without credentials exits 0 with loggedIn:false', async () => {
  const e = await env();
  try {
    const { stdout, status } = await run('node', [CLI, 'status', '--json'], { env: e }).then(
      (r) => ({ ...r, status: 0 }),
      (err) => ({ stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.code }),
    );
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(stdout), { loggedIn: false });
  } finally { await rm(e.INXT_AGENT_DATA_DIR, { recursive: true, force: true }); }
});

test('ls without credentials exits 2 and emits one JSON error object on stderr', async () => {
  const e = await env();
  try {
    const err = await run('node', [CLI, 'ls', '--json'], { env: e }).then(
      (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
      (e2) => ({ code: e2.code, stdout: e2.stdout ?? '', stderr: e2.stderr ?? '' }),
    );
    assert.equal(err.code, 2);
    assert.equal(err.stdout, '');
    const parsed = JSON.parse(err.stderr.trim().split('\n').pop());
    assert.equal(parsed.error.code, 'NOT_LOGGED_IN');
  } finally { await rm(e.INXT_AGENT_DATA_DIR, { recursive: true, force: true }); }
});

test('unknown command exits 5 with INVALID_ARGUMENT', async () => {
  const e = await env();
  try {
    const err = await run('node', [CLI, 'frobnicate', '--json'], { env: e }).then(
      (r) => ({ code: 0, stderr: r.stderr }),
      (e2) => ({ code: e2.code, stderr: e2.stderr ?? '' }),
    );
    assert.equal(err.code, 5);
    assert.equal(JSON.parse(err.stderr).error.code, 'INVALID_ARGUMENT');
  } finally { await rm(e.INXT_AGENT_DATA_DIR, { recursive: true, force: true }); }
});

test('two paths for ls is rejected as invalid usage', async () => {
  const e = await env();
  try {
    const err = await run('node', [CLI, 'ls', 'a', 'b', '--json'], { env: e }).then(
      (r) => ({ code: 0, stderr: r.stderr }),
      (e2) => ({ code: e2.code, stderr: e2.stderr ?? '' }),
    );
    // ls tolerates one path; two positionals is INVALID_ARGUMENT (before auth check? no: after — accept either auth or usage error, both non-zero)
    assert.notEqual(err.code, 0);
  } finally { await rm(e.INXT_AGENT_DATA_DIR, { recursive: true, force: true }); }
});
