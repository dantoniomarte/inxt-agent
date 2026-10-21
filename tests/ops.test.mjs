import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DriveRepo } from '../dist/core/drive.js';

const ROOT = '00000000-0000-4000-8000-000000000000';
const F1 = '11111111-0000-4000-8000-000000000001';
const FILE1 = '33333333-0000-4000-8000-000000000003';

function startFake() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (b, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, path: url.pathname, body: body ? JSON.parse(body) : null, query: Object.fromEntries(url.searchParams) });
      if (req.method === 'PATCH' && url.pathname === `/folders/${F1}`) return json({ uuid: F1, plainName: 'moved' });
      if (req.method === 'PATCH' && url.pathname === `/files/${FILE1}`) return json({ uuid: FILE1, plainName: 'moved' });
      if (req.method === 'PUT' && url.pathname.endsWith('/meta')) return json({});
      if (req.method === 'POST' && url.pathname === '/storage/trash/add') return json({});
      if (req.method === 'DELETE' && url.pathname === '/storage/trash') return json({});
      if (req.method === 'DELETE' && url.pathname === '/storage/trash/all') return json({});
      if (req.method === 'GET' && url.pathname === '/storage/trash/paginated') {
        return json({ result: url.searchParams.get('type') === 'files'
          ? [{ uuid: FILE1, plainName: 'gone', type: 'txt', size: '12' }]
          : [{ uuid: 'aaaaaaaa-0000-4000-8000-00000000000a', plainName: 'old-folder' }] });
      }
      if (req.method === 'GET' && url.pathname === '/users/usage') return json({ total: 100, drive: 40, backups: 5 });
      if (req.method === 'POST' && url.pathname.startsWith('/fuzzy/')) return json({ data: [{ itemId: FILE1, itemType: 'file', item: { plainName: 'doc', type: 'pdf', size: '7' } }] });
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

test('move file/folder sends PATCH with destinationFolder (+optional name)', async () => {
  const { server, port, requests } = await startFake();
  const repo = new DriveRepo({ driveApiUrl: `http://127.0.0.1:${port}` }, () => 't');
  try {
    await repo.move(FILE1, 'file', F1);
    await repo.move(FILE1, 'file', F1, 'renamed.txt');
    const patches = requests.filter((r) => r.method === 'PATCH');
    assert.deepEqual(patches[0].body, { destinationFolder: F1 });
    assert.deepEqual(patches[1].body, { destinationFolder: F1, name: 'renamed.txt' });
    await repo.move(F1, 'folder', ROOT);
    assert.ok(requests.some((r) => r.method === 'PATCH' && r.path === `/folders/${F1}`));
  } finally { server.close(); }
});

test('rename uses the meta endpoints with plainName/name', async () => {
  const { server, port, requests } = await startFake();
  const repo = new DriveRepo({ driveApiUrl: `http://127.0.0.1:${port}` }, () => 't');
  try {
    await repo.rename(F1, 'folder', 'NewName');
    await repo.rename(FILE1, 'file', 'NewName.txt');
    const puts = requests.filter((r) => r.method === 'PUT' && r.path.endsWith('/meta'));
    assert.deepEqual(puts[0].body, { plainName: 'NewName' });
    assert.ok(puts[1], 'file rename PUT recorded');
  } finally { server.close(); }
});

test('trash + purge + empty use the drive-web endpoints', async () => {
  const { server, port, requests } = await startFake();
  const repo = new DriveRepo({ driveApiUrl: `http://127.0.0.1:${port}` }, () => 't');
  try {
    await repo.trash(FILE1, 'file');
    assert.deepEqual(requests.find((r) => r.path === '/storage/trash/add')?.body, { items: [{ uuid: FILE1, type: 'file' }] });
    await repo.deletePermanent([{ uuid: FILE1, type: 'file' }]);
    assert.ok(requests.some((r) => r.method === 'DELETE' && r.path === '/storage/trash'));
    await repo.clearTrash();
    assert.ok(requests.some((r) => r.method === 'DELETE' && r.path === '/storage/trash/all'));
  } finally { server.close(); }
});

test('listTrash reads the paginated endpoint (both types, root=true)', async () => {
  const { server, port, requests } = await startFake();
  const repo = new DriveRepo({ driveApiUrl: `http://127.0.0.1:${port}` }, () => 't');
  try {
    const { folders, files } = await repo.listTrash();
    assert.equal(files[0]?.name, 'gone.txt');
    assert.equal(folders[0]?.name, 'old-folder');
    const calls = requests.filter((r) => r.path === '/storage/trash/paginated');
    assert.equal(calls.length, 2);
    assert.equal(calls.every((c) => c.query.root === 'true'), true);
  } finally { server.close(); }
});

test('quota normalizes UsageResponseV2 and search maps fuzzy results', async () => {
  const { server, port } = await startFake();
  const repo = new DriveRepo({ driveApiUrl: `http://127.0.0.1:${port}` }, () => 't');
  try {
    assert.deepEqual(await repo.quota(), { total: 100, used: 45 });
    const results = await repo.search('doc');
    assert.equal(results[0]?.name, 'doc.pdf');
    assert.equal(results[0]?.kind, 'file');
  } finally { server.close(); }
});

test('restore delegates to move with parent + name', async () => {
  const { server, port, requests } = await startFake();
  const repo = new DriveRepo({ driveApiUrl: `http://127.0.0.1:${port}` }, () => 't');
  try {
    await repo.restore(FILE1, 'file', ROOT, 'gone.txt');
    const patch = requests.find((r) => r.method === 'PATCH' && r.path === `/files/${FILE1}`);
    assert.deepEqual(patch?.body, { destinationFolder: ROOT, name: 'gone.txt' });
  } finally { server.close(); }
});
