import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCredentials, loadCredentials, clearCredentials, redactCredentials } from '../dist/core/credentials.js';
import { AgentError } from '../dist/core/errors.js';

const CFG = () => ({ dataDir: '' });
const sample = () => ({
  version: 1,
  savedAt: new Date().toISOString(),
  token: 't'.repeat(50),
  user: {
    uuid: 'u-uuid', email: 'a@b.c', bridgeUser: 'bridge', userId: 'u-idx',
    bucket: 'bucket-1', rootFolderId: 'root-uuid',
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    keys: { ecc: { privateKey: 'P'.repeat(60), publicKey: 'pub' } },
  },
});

test('save/load roundtrip persists credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inxt-test-'));
  const config = { ...CFG(), dataDir: dir };
  try {
    await saveCredentials(config, sample());
    const loaded = await loadCredentials(config);
    assert.equal(loaded.user.email, 'a@b.c');
    assert.equal(loaded.user.bucket, 'bucket-1');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('credentials file and dir have restrictive permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inxt-test-'));
  const config = { ...CFG(), dataDir: dir };
  try {
    await saveCredentials(config, sample());
    const dirStat = await stat(dir);
    const fileStat = await stat(join(dir, 'credentials.json'));
    assert.equal(dirStat.mode & 0o077, 0, 'dir must be 0700');
    assert.equal(fileStat.mode & 0o077, 0, 'file must be 0600');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('load without credentials throws NOT_LOGGED_IN (exit 2)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inxt-test-'));
  const config = { ...CFG(), dataDir: dir };
  try {
    await assert.rejects(() => loadCredentials(config), (e) => e instanceof AgentError && e.code === 'NOT_LOGGED_IN' && e.exitCode === 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('clearCredentials removes the file and is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inxt-test-'));
  const config = { ...CFG(), dataDir: dir };
  try {
    await saveCredentials(config, sample());
    await clearCredentials(config);
    await assert.rejects(() => loadCredentials(config));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('redactCredentials never exposes token/mnemonic/privateKey/bridgeUser values', () => {
  const view = redactCredentials(sample());
  const s = JSON.stringify(view);
  assert.ok(!s.includes('t'.repeat(50)));
  assert.ok(!s.includes('abandon'));
  assert.ok(!s.includes('P'.repeat(60)));
  assert.equal(view.token, `<redacted:50 chars>`);
  assert.equal(view.user.bridgeUser, '<redacted>');
  assert.equal(view.user.keys.ecc.privateKey, '<redacted>');
  assert.equal(view.user.email, 'a@b.c'); // email is fine
});
