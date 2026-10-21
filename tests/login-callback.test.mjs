import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startCallbackServer } from '../dist/core/login.js';

const CONFIG = { driveWebUrl: 'https://drive.internxt.com' };

const b64 = (s) => Buffer.from(s).toString('base64');

function getFollow(host, port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
  });
}

test('callback server returns credentials and redirects to auth-link-ok', async () => {
  const cb = await startCallbackServer(CONFIG, 0);
  try {
    assert.equal(cb.port > 0, true);
    assert.ok(cb.loginUrl.startsWith('https://drive.internxt.com/login?'));
    assert.ok(cb.loginUrl.includes('universalLink=true'));
    const waitP = cb.wait();
    const res = await getFollow('127.0.0.1', cb.port,
      `/callback?mnemonic=${b64('mnemonic-words')}&newToken=${b64('jwt-token')}&privateKey=${b64('priv-key')}`);
    assert.equal(res.status, 302);
    assert.equal(res.location, 'https://drive.internxt.com/auth-link-ok');
    const result = await waitP;
    assert.equal(result.mnemonic, 'mnemonic-words');
    assert.equal(result.token, 'jwt-token');
    assert.equal(result.privateKey, 'priv-key');
  } finally { cb.close(); }
});

test('missing param redirects to auth-link-error and rejects the wait', async () => {
  const cb = await startCallbackServer(CONFIG, 0);
  try {
    const waitP = cb.wait().then(() => { throw new Error('should not resolve'); }, (e) => e);
    const res = await getFollow('127.0.0.1', cb.port, '/callback?mnemonic=xxx');
    assert.equal(res.location, 'https://drive.internxt.com/auth-link-error');
    const err = await waitP;
    assert.match(err.message, /newToken/);
  } finally { cb.close(); }
});

test('unknown path answers 404 without ending the login', async () => {
  const cb = await startCallbackServer(CONFIG, 0);
  try {
    const res = await getFollow('127.0.0.1', cb.port, '/other');
    assert.equal(res.status, 404);
    // still operational afterwards
    const waitP = cb.wait();
    const ok = await getFollow('127.0.0.1', cb.port,
      `/callback?mnemonic=${b64('m')}&newToken=${b64('t')}&privateKey=${b64('p')}`);
    assert.equal(ok.status, 302);
    assert.equal((await waitP).token, 't');
  } finally { cb.close(); }
});
