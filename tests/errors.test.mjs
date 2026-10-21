import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentError, toAgentError, sanitizeMessage } from '../dist/core/errors.js';

test('exit codes are stable per code', () => {
  assert.equal(new AgentError('NOT_LOGGED_IN', 'x').exitCode, 2);
  assert.equal(new AgentError('AUTH_EXPIRED', 'x').exitCode, 2);
  assert.equal(new AgentError('PATH_NOT_FOUND', 'x').exitCode, 4);
  assert.equal(new AgentError('INVALID_ARGUMENT', 'x').exitCode, 5);
  assert.equal(new AgentError('RATE_LIMITED', 'x').exitCode, 7);
  assert.equal(new AgentError('NETWORK', 'x').exitCode, 8);
  assert.equal(new AgentError('CONFIRMATION_REQUIRED', 'x').exitCode, 12);
  assert.equal(new AgentError('SERVER', 'x').exitCode, 13);
});

test('toAgentError maps axios-like statuses', () => {
  const e404 = toAgentError(Object.assign(new Error('nf'), { response: { status: 404 } }));
  assert.equal(e404.code, 'PATH_NOT_FOUND');
  const e401 = toAgentError(Object.assign(new Error('no'), { response: { status: 401 } }));
  assert.equal(e401.code, 'AUTH_EXPIRED');
  const e429 = toAgentError(Object.assign(new Error('rl'), { response: { status: 429 } }));
  assert.equal(e429.code, 'RATE_LIMITED');
  const e500 = toAgentError(Object.assign(new Error('srv'), { response: { status: 502 } }));
  assert.equal(e500.code, 'SERVER');
  assert.equal(toAgentError(new Error('plain')).code, 'UNKNOWN');
});

test('sanitizeMessage redacts long tokens', () => {
  const msg = 'failed with eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 Signature verification failed';
  const out = sanitizeMessage(msg);
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
  assert.ok(out.includes('<redacted>'));
});

test('error JSON is safe and structured', () => {
  const e = new AgentError('PATH_NOT_FOUND', 'not here', { details: { segment: 'x' } });
  const j = e.toJSON();
  assert.equal(j.error.code, 'PATH_NOT_FOUND');
  assert.equal(j.error.details.segment, 'x');
});
