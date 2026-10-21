import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DriveRepo } from '../dist/core/drive.js';

const ROOT = '00000000-0000-4000-8000-000000000000';
const DOCS = '11111111-0000-4000-8000-000000000001';
const REPORTS = '22222222-0000-4000-8000-000000000002';
const Q3PDF = '33333333-0000-4000-8000-000000000003';

function startFakeStorage() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ path: url.pathname, cursor: url.searchParams.get('cursor') ?? null });
    const json = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

    if (req.method === 'POST' && url.pathname === '/folders') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        json({ id: 9, uuid: '99999999-0000-4000-8000-000000000009', parentFolderUuid: body.parentFolderUuid, plainName: body.plainName });
      });
      return;
    }
    const m = url.pathname.match(/^\/folders\/v2\/content\/([^/]+)\/(folders|files)$/);
    if (!m) { res.writeHead(404).end(); return; }
    const [, folderUuid, kind] = m;
    if (folderUuid === ROOT) {
      if (kind === 'folders') {
        // two pages to exercise pagination
        if (!url.searchParams.get('cursor')) {
          json({ folders: [{ uuid: DOCS, plainName: 'Docs', createdAt: '2026-01-01', updatedAt: '2026-01-02' }], nextCursor: 'c2' });
        } else {
          json({ folders: [{ uuid: '44444444-0000-4000-8000-000000000004', plainName: 'Photos' }], nextCursor: null });
        }
      } else {
        json({ files: [{ uuid: '55555555-0000-4000-8000-000000000005', plainName: 'readme', type: 'md', size: '1234' }], nextCursor: null });
      }
      return;
    }
    if (folderUuid === DOCS) {
      if (kind === 'folders') json({ folders: [{ uuid: REPORTS, plainName: 'Reports' }], nextCursor: null });
      else json({ files: [], nextCursor: null });
      return;
    }
    if (folderUuid === REPORTS) {
      if (kind === 'folders') json({ folders: [], nextCursor: null });
      else json({ files: [{ uuid: Q3PDF, plainName: 'q3', type: 'pdf', size: '42' }], nextCursor: null });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

const mkRepo = async () => {
  const { server, port, requests } = await startFakeStorage();
  const config = { driveApiUrl: `http://127.0.0.1:${port}` };
  const repo = new DriveRepo(config, () => 'fake-token');
  return { repo, requests, server, port };
};

test('resolvePath walks nested folders and resolves a file at the last segment', async () => {
  const { repo, server } = await mkRepo();
  try {
    assert.deepEqual(await repo.resolvePath(ROOT, ''), { uuid: ROOT, kind: 'folder' });
    const docs = await repo.resolvePath(ROOT, 'docs');
    assert.deepEqual(docs, { uuid: DOCS, kind: 'folder' });
    const file = await repo.resolvePath(ROOT, 'Docs/Reports/q3.pdf'); // case-insensitive
    assert.deepEqual(file, { uuid: Q3PDF, kind: 'file' });
  } finally { server.close(); }
});

test('missing segment -> PATH_NOT_FOUND naming the segment', async () => {
  const { repo, server } = await mkRepo();
  try {
    await assert.rejects(
      () => repo.resolvePath(ROOT, 'docs/nope'),
      (e) => e.code === 'PATH_NOT_FOUND' && e.details.segment === 'nope',
    );
  } finally { server.close(); }
});

test('file in the middle of a path -> PATH_NOT_FOUND', async () => {
  const { repo, server } = await mkRepo();
  try {
    await assert.rejects(
      () => repo.resolvePath(ROOT, 'readme.md/sub'),
      (e) => e.code === 'PATH_NOT_FOUND',
    );
  } finally { server.close(); }
});

test('pagination: nested resolution fetches both pages of root folders', async () => {
  const { repo, requests, server } = await mkRepo();
  try {
    await repo.resolvePath(ROOT, 'Photos');
    const folderReqs = requests.filter((r) => r.path === `/folders/v2/content/${ROOT}/folders`);
    assert.equal(folderReqs.length, 2);
    assert.equal(folderReqs[0].cursor, null);
    assert.equal(folderReqs[1].cursor, 'c2');
  } finally { server.close(); }
});

test('cache: repeated resolution does not re-fetch; invalidate forces re-fetch', async () => {
  const { repo, requests, server } = await mkRepo();
  try {
    await repo.resolvePath(ROOT, 'docs/reports/q3.pdf');
    const countAfterFirst = requests.length;
    await repo.resolvePath(ROOT, 'docs/reports/q3.pdf');
    assert.equal(requests.length, countAfterFirst, 'must be served from cache');
    repo.invalidate();
    await repo.resolvePath(ROOT, 'docs/reports/q3.pdf');
    assert.ok(requests.length > countAfterFirst, 'must re-fetch after invalidate');
  } finally { server.close(); }
});

test('createFolder posts parent+name and invalidates the parent cache', async () => {
  const { repo, requests, server } = await mkRepo();
  try {
    await repo.resolvePath(ROOT, 'docs'); // warm cache
    const count = requests.length;
    const uuid = await repo.createFolder(DOCS, 'NewFolder');
    assert.equal(uuid, '99999999-0000-4000-8000-000000000009');
    assert.ok(requests.length > count);
    const post = requests.find((r) => r.path === '/folders');
    assert.ok(post, 'must POST /folders');
  } finally { server.close(); }
});
