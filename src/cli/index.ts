#!/usr/bin/env node
/**
 * inxt-agent CLI — agent access to Internxt Drive.
 *
 * Output contract (stable for agents):
 *   - `--json`: exactly one JSON object on stdout; errors go to stderr as one JSON object.
 *   - exit codes: 0 ok · 1 internal · 2 auth (login/re-login) · 4 not-found/exists ·
 *     5 invalid-arg · 6 quota · 7 rate-limited · 8 network · 9 aborted · 10 crypto ·
 *     11 permissions · 12 confirmation-required · 13 server.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { loadConfig } from '../core/config.js';
import { performLogin, performLogout, getSession, refreshSession, completeLoginFromCallbackUrl } from '../core/auth.js';
import { buildLoginUrl } from '../core/login.js';
import { redactCredentials, hasCredentials } from '../core/credentials.js';
import { DriveRepo } from '../core/drive.js';
import { TransferEngine, splitName } from '../transfer/engine.js';
import { AgentError, isAgentError, toAgentError } from '../core/errors.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  json: boolean;
  port: number;
  yes: boolean;
  remote: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let rest = [...argv];
  // `inxt-agent --help` (flags before the command) is normalized to the help command.
  let command = rest[0] ?? 'help';
  if (command.startsWith('-')) {
    command = 'help';
  } else {
    rest = rest.slice(1);
  }
  const parsed: ParsedArgs = { command, positional: [], json: false, port: 0, yes: false, remote: false, help: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === '--json') parsed.json = true;
    else if (a === '--yes') parsed.yes = true;
    else if (a === '--remote') parsed.remote = true;
    else if (a === '--help' || a === '-h') parsed.help = true;
    else if (a === '--port') {
      const v = Number(rest[++i]);
      if (!Number.isInteger(v) || v < 0 || v > 65535) {
        throw new AgentError('INVALID_ARGUMENT', '--port expects an integer between 0 and 65535');
      }
      parsed.port = v;
    } else if (a.startsWith('--')) {
      throw new AgentError('INVALID_ARGUMENT', `Unknown flag: ${a}`);
    } else {
      parsed.positional.push(a);
    }
  }
  return parsed;
}

function openBrowser(url: string): void {
  try {
    const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    // Headless or no xdg-open: the URL was printed to stderr; the agent will relay it.
  }
}

function requireOnePath(args: ParsedArgs, command: string): string {
  const p = args.positional[0];
  if (p === undefined || args.positional.length > 1) {
    throw new AgentError('INVALID_ARGUMENT', `usage: inxt-agent ${command} <path>`);
  }
  if (p.includes('\\') || p.includes('\0')) {
    throw new AgentError('INVALID_ARGUMENT', 'path must not contain backslashes or NUL');
  }
  return p;
}

async function cmdCp(args: ParsedArgs): Promise<Record<string, unknown>> {
  const [local, remote] = args.positional;
  if (!local || !remote || args.positional.length !== 2) {
    throw new AgentError('INVALID_ARGUMENT', 'usage: inxt-agent cp <local-file> <remote-dir-or-file>');
  }
  const config = loadConfig();
  const creds = await getSession(config);
  const st = await stat(local).catch(() => undefined);
  if (!st?.isFile()) throw new AgentError('INVALID_ARGUMENT', `local path is not a file: ${local}`);
  const repo = new DriveRepo(config, () => creds.token);
  const slash = remote.lastIndexOf('/');
  const parentPath = slash > 0 ? remote.slice(0, slash) : '';
  const fileName = slash >= 0 ? remote.slice(slash + 1) : remote;
  if (fileName.length === 0) throw new AgentError('INVALID_ARGUMENT', 'remote file name is empty');
  const parentUuid = await repo.resolveFolder(creds.user.rootFolderId, parentPath);
  // Overwrite: existing file in the same folder with the same name+type goes to trash first.
  const { plainName, type } = splitName(fileName);
  const existing = await repo.findFileByName(parentUuid, fileName);
  const engine = new TransferEngine(config, creds.user);
  if (existing) {
    if (!args.yes) {
      throw new AgentError('CONFIRMATION_REQUIRED', `remote file exists: ${remote} (use --yes to overwrite via trash)`);
    }
    await repo.trash(existing.uuid, 'file');
  }
  const result = await engine.uploadFile({
    token: creds.token,
    localPath: local,
    size: st.size,
    folderUuid: parentUuid,
    name: fileName,
  });
  repo.invalidate(parentUuid);
  void plainName; void type;
  return { uploaded: remote, uuid: result.driveUuid, networkFileId: result.networkFileId, size: st.size };
}

async function cmdGet(args: ParsedArgs): Promise<Record<string, unknown>> {
  const [remote, local] = args.positional;
  if (!remote || !local || args.positional.length !== 2) {
    throw new AgentError('INVALID_ARGUMENT', 'usage: inxt-agent get <remote-file> <local-dir-or-file>');
  }
  const config = loadConfig();
  const creds = await getSession(config);
  const repo = new DriveRepo(config, () => creds.token);
  const resolved = await repo.resolvePath(creds.user.rootFolderId, remote);
  if (resolved.kind !== 'file') throw new AgentError('PATH_NOT_FOUND', `remote path is not a file: ${remote}`);
  const meta = await repo.getFileMeta(resolved.uuid);
  const engine = new TransferEngine(config, creds.user);
  await engine.downloadToFile({ fileId: meta.fileId, destinationPath: local });
  return { downloaded: remote, to: local, size: meta.size };
}

async function cmdRm(args: ParsedArgs): Promise<Record<string, unknown>> {
  const target = requireOnePath(args, 'rm');
  if (!args.yes) {
    throw new AgentError('CONFIRMATION_REQUIRED', `rm moves to trash: ${target} (use --yes to confirm)`);
  }
  const config = loadConfig();
  const creds = await getSession(config);
  const repo = new DriveRepo(config, () => creds.token);
  const resolved = await repo.resolvePath(creds.user.rootFolderId, target);
  await repo.trash(resolved.uuid, resolved.kind);
  return { trashed: target, uuid: resolved.uuid, kind: resolved.kind };
}

async function cmdEmptyTrash(args: ParsedArgs): Promise<Record<string, unknown>> {
  if (!args.yes) {
    throw new AgentError('CONFIRMATION_REQUIRED', 'emptying the trash is IRREVERSIBLE (use --yes)');
  }
  const config = loadConfig();
  const creds = await getSession(config);
  const repo = new DriveRepo(config, () => creds.token);
  await repo.clearTrash();
  return { emptied: true };
}

async function cmdLogin(args: ParsedArgs): Promise<Record<string, unknown>> {
  const config = loadConfig();
  if (args.remote) {
    // Headless paste-back (see core/headless.ts): throwaway redirect, paste the
    // address-bar URL back on stdin. The pasted value IS the credential set: never echo it.
    const loginUrl = buildLoginUrl(config, 1);
    process.stderr.write(
      `Headless login (paste-back mode):
` +
      `  1. Open this URL on ANY machine with a browser (your laptop works):
     ${loginUrl}
` +
      `  2. Log in to your Internxt account there. The browser will fail to connect
` +
      `     (http://127.0.0.1:1 refused) - that is EXPECTED.
` +
      `  3. Copy the FULL URL from the address bar and paste it here, then Enter.
`,
    );
    const pasted = await readLineStdin();
    const { user } = await completeLoginFromCallbackUrl(config, pasted);
    return { loggedIn: true, email: user.email, rootFolderId: user.rootFolderId };
  }
  if (args.port > 0) {
    // Automatic-over-SSH mode: the local browser's localhost redirect reaches this
    // machine's callback server through the tunnel.
    process.stderr.write(
      `SSH-tunnel mode: first run this on YOUR machine (replace user@host):
` +
      `  ssh -L ${args.port}:127.0.0.1:${args.port} user@host
` +
      `Then open the printed URL in the LOCAL browser; the redirect reaches the callback
` +
      `server here through the tunnel and the login completes automatically.
`,
    );
  }
  const { user } = await performLogin(config, args.port, openBrowser);
  return { loggedIn: true, email: user.email, rootFolderId: user.rootFolderId };
}

function readLineStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    const onData = (c: string): void => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        cleanup();
        resolve(buf.slice(0, nl));
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(buf.trim().length > 0 ? buf : '');
    };
    const onErr = (e: Error): void => {
      cleanup();
      reject(e);
    };
    function cleanup(): void {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onErr);
    }
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onErr);
  });
}

async function cmdStatus(args: ParsedArgs): Promise<Record<string, unknown>> {
  const config = loadConfig();
  if (!(await hasCredentials(config))) return { loggedIn: false };
  const creds = await getSession(config);
  return { loggedIn: true, savedAt: creds.savedAt, user: redactCredentials(creds).user };
}

async function cmdLogout(): Promise<Record<string, unknown>> {
  await performLogout(loadConfig());
  return { loggedOut: true };
}

async function cmdLs(args: ParsedArgs): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const creds = await getSession(config);
  const targetPath = args.positional[0] ?? '';
  const repo = new DriveRepo(config, () => creds.token);
  const resolved = await repo.resolvePath(creds.user.rootFolderId, targetPath);
  if (resolved.kind === 'file') {
    return { path: targetPath, items: [{ kind: 'file', path: targetPath, uuid: resolved.uuid }] };
  }
  const { folders, files } = await repo.listFolder(resolved.uuid);
  return {
    path: targetPath,
    folderUuid: resolved.uuid,
    items: [...folders, ...files].map((it) => ({
      kind: it.kind,
      name: it.name,
      uuid: it.uuid,
      ...(it.kind === 'file' ? { size: it.size } : {}),
      updatedAt: it.updatedAt ?? null,
    })),
  };
}

async function cmdMkdir(args: ParsedArgs): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const creds = await getSession(config);
  const targetPath = requireOnePath(args, 'mkdir');
  const repo = new DriveRepo(config, () => creds.token);
  const uuid = await mkdirRecursive(repo, creds.user.rootFolderId, targetPath);
  return { created: targetPath, uuid };
}

/** mkdir -p semantics: walk as deep as the path exists, create the rest. */
async function mkdirRecursive(repo: DriveRepo, rootFolderId: string, path: string): Promise<string> {
  const segments = path.split('/').map((s) => s.trim()).filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0) {
    throw new AgentError('INVALID_ARGUMENT', 'mkdir requires a non-empty path');
  }
  let current = rootFolderId;
  let createdAny = false;
  const created: string[] = [];
  for (const seg of segments) {
    try {
      const res = await repo.resolvePath(current, seg);
      if (res.kind !== 'folder') {
        throw new AgentError('ALREADY_EXISTS', `"${seg}" already exists as a file (path "${path}")`);
      }
      current = res.uuid;
    } catch (e) {
      if (isAgentError(e) && e.code === 'PATH_NOT_FOUND') {
        current = await repo.createFolder(current, seg);
        createdAny = true;
        created.push(seg);
      } else {
        throw e;
      }
    }
  }
  if (createdAny) repo.invalidate();
  return current;
}

async function cmdMv(args: ParsedArgs): Promise<Record<string, unknown>> {
  const [source, dest] = args.positional;
  if (!source || !dest || args.positional.length !== 2) {
    throw new AgentError('INVALID_ARGUMENT', 'usage: inxt-agent mv <remote-src> <remote-dest-dir|remote-dest-path>');
  }
  const config = loadConfig();
  const creds = await getSession(config);
  const repo = new DriveRepo(config, () => creds.token);
  const src = await repo.resolvePath(creds.user.rootFolderId, source);
  // Destination: if it ends with a known-new name (not existing), split parent + rename.
  const slash = dest.lastIndexOf('/');
  const parentPath = slash > 0 ? dest.slice(0, slash) : '';
  const leaf = slash >= 0 ? dest.slice(slash + 1) : dest;
  const parentUuid = await repo.resolveFolder(creds.user.rootFolderId, parentPath);
  let renameTo: string | undefined;
  let destination = parentUuid;
  try {
    const existing = await repo.resolvePath(creds.user.rootFolderId, dest);
    if (existing.kind !== 'folder') {
      throw new AgentError('ALREADY_EXISTS', `destination exists as a file: ${dest}`);
    }
    destination = existing.uuid;
  } catch (e) {
    if (isAgentError(e) && e.code === 'PATH_NOT_FOUND') {
      renameTo = leaf; // dest does not exist -> move into parent AND rename to leaf
    } else {
      throw e;
    }
  }
  await repo.move(src.uuid, src.kind, destination, renameTo);
  return { moved: source, to: dest, kind: src.kind, renamed: renameTo ?? null };
}

async function cmdRename(args: ParsedArgs): Promise<Record<string, unknown>> {
  const [target, newName] = args.positional;
  if (!target || !newName || args.positional.length !== 2) {
    throw new AgentError('INVALID_ARGUMENT', 'usage: inxt-agent rename <remote-path> <new-name>');
  }
  if (newName.includes('/')) {
    throw new AgentError('INVALID_ARGUMENT', 'new name must be a bare name (no slashes)');
  }
  const config = loadConfig();
  const creds = await getSession(config);
  const repo = new DriveRepo(config, () => creds.token);
  const resolved = await repo.resolvePath(creds.user.rootFolderId, target);
  await repo.rename(resolved.uuid, resolved.kind, newName);
  return { renamed: target, to: newName, kind: resolved.kind };
}

async function cmdTrashList(): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const creds = await getSession(config);
  const repo = new DriveRepo(config, () => creds.token);
  const { folders, files } = await repo.listTrash();
  return {
    items: [
      ...folders.map((f) => ({ kind: 'folder', uuid: f.uuid, name: f.name })),
      ...files.map((f) => ({ kind: 'file', uuid: f.uuid, name: f.name, size: f.size })),
    ],
  };
}

async function cmdTrashRestore(args: ParsedArgs): Promise<Record<string, unknown>> {
  const target = args.positional[1];
  if (!target) throw new AgentError('INVALID_ARGUMENT', 'usage: inxt-agent trash restore <name> --yes');
  const config = loadConfig();
  const creds = await getSession(config);
  const repo = new DriveRepo(config, () => creds.token);
  // Resolve the item inside the trash listing by name (path semantics do not apply there).
  const { folders, files } = await repo.listTrash();
  const base = target.split('/').pop() ?? target;
  const folder = folders.find((f) => f.name.toLowerCase() === base.toLowerCase());
  const file = files.find((f) => f.name.toLowerCase() === base.toLowerCase());
  const item = folder ?? file;
  if (!item) throw new AgentError('PATH_NOT_FOUND', `"${base}" not found in trash`);
  if (!args.yes) {
    throw new AgentError('CONFIRMATION_REQUIRED', `restore "${item.name}"? use --yes to confirm`);
  }
  // Restore to the root folder (original parent is not exposed by the listing; drive-web
  // uses the item's parent metadata, we restore to root and say so in the output).
  await repo.restore(item.uuid, item.kind, creds.user.rootFolderId, item.name);
  return { restored: item.name, kind: item.kind, to: 'root' };
}

async function cmdRmPermanent(args: ParsedArgs): Promise<Record<string, unknown>> {
  const target = args.positional[0];
  if (!target) throw new AgentError('INVALID_ARGUMENT', 'usage: inxt-agent purge <name> --yes');
  if (!args.yes) {
    throw new AgentError('CONFIRMATION_REQUIRED', `permanent delete is IRREVERSIBLE: ${target} (use --yes)`);
  }
  const config = loadConfig();
  const creds = await getSession(config);
  const repo = new DriveRepo(config, () => creds.token);
  // Resolve in trash by name, same as restore.
  const { folders, files } = await repo.listTrash();
  const base = target.split('/').pop() ?? target;
  const folder = folders.find((f) => f.name.toLowerCase() === base.toLowerCase());
  const file = files.find((f) => f.name.toLowerCase() === base.toLowerCase());
  const item = folder ?? file;
  if (!item) throw new AgentError('PATH_NOT_FOUND', `"${base}" not found in trash`);
  await repo.deletePermanent([{ uuid: item.uuid, type: item.kind }]);
  return { deletedPermanently: item.name, kind: item.kind };
}

async function cmdQuota(): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const creds = await getSession(config);
  const repo = new DriveRepo(config, () => creds.token);
  return await repo.quota();
}

async function cmdSearch(args: ParsedArgs): Promise<Record<string, unknown>> {
  const term = requireOnePath(args, 'search');
  const config = loadConfig();
  const creds = await getSession(config);
  const repo = new DriveRepo(config, () => creds.token);
  const results = await repo.search(term);
  return { term, items: results.map((f) => ({ uuid: f.uuid, name: f.name, kind: f.kind, size: f.size })) };
}

function runCommand(args: ParsedArgs): Promise<Record<string, unknown>> {
  switch (args.command) {
    case 'login':
      return cmdLogin(args);
    case 'status':
      return cmdStatus(args);
    case 'logout':
      return cmdLogout();
    case 'ls':
      return cmdLs(args);
    case 'mkdir':
      return cmdMkdir(args);
    case 'cp':
      return cmdCp(args);
    case 'get':
      return cmdGet(args);
    case 'rm':
      return cmdRm(args);
    case 'mv':
      return cmdMv(args);
    case 'rename':
      return cmdRename(args);
    case 'trash':
      return args.positional[0] === 'restore' ? cmdTrashRestore(args) : cmdTrashList();
    case 'purge':
      return cmdRmPermanent(args);
    case 'emptytrash':
      return cmdEmptyTrash(args);
    case 'quota':
      return cmdQuota();
    case 'search':
      return cmdSearch(args);
    default:
      return Promise.reject(new AgentError('INVALID_ARGUMENT', `Unknown command: ${args.command} (try --help)`));
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === 'help') {
    const help = {
      usage: 'inxt-agent <command> [args] [--json]',
      commands: {
        login: 'Authorize via browser (universal-link). Flags: --port N (SSH tunnel), --remote (headless paste-back)',
        status: 'Show stored session (redacted). Exits 0 with loggedIn:false when not logged in.',
        logout: 'Invalidate session server-side (best effort) and wipe local credentials.',
        ls: 'List a remote path. usage: inxt-agent ls [path]',
        mkdir: 'Create a folder (recursive). usage: inxt-agent mkdir <path>',
        cp: 'Upload a local file. usage: inxt-agent cp <local-file> <remote-dir-or-file> [--yes]',
        get: 'Download a remote file. usage: inxt-agent get <remote-file> <local-path>',
        rm: 'Move a remote path to the trash. usage: inxt-agent rm <path> --yes',
        mv: 'Move (and optionally rename). usage: inxt-agent mv <remote-src> <remote-dir-or-path>',
        rename: 'Rename in place. usage: inxt-agent rename <remote-path> <new-name>',
        trash: 'Trash operations: `trash` (list), `trash restore <name> --yes`',
        purge: 'Permanently delete a trashed item (IRREVERSIBLE). usage: purge <name> --yes',
        emptytrash: 'Empty the whole trash (IRREVERSIBLE). usage: emptytrash --yes',
        quota: 'Show account usage/limits.',
        search: 'Search files by name. usage: inxt-agent search <term>',
      },
    };
    if (args.json) console.log(JSON.stringify(help));
    else console.log(JSON.stringify(help, null, 2));
    return 0;
  }

  let out: Record<string, unknown>;
  try {
    out = await runCommand(args);
  } catch (e) {
    // Retry once with a refreshed token when the server rejects the session (401/403).
    // refreshSession persists the rotation, and commands re-read credentials, so the
    // retry runs with fresh auth. A second AUTH_EXPIRED propagates (no loops).
    const err = isAgentError(e) ? e : toAgentError(e);
    if (err.code !== 'AUTH_EXPIRED' || args.command === 'login' || args.command === 'status') {
      throw err;
    }
    const config = loadConfig();
    const creds = await getSession(config);
    await refreshSession(config, creds);
    out = await runCommand(args);
  }
  if (args.json) console.log(JSON.stringify(out));
  else console.log(JSON.stringify(out, null, 2));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    const err = isAgentError(e) ? e : toAgentError(e);
    if (process.argv.includes('--json')) {
      process.stderr.write(JSON.stringify(err.toJSON()) + '\n');
    } else {
      process.stderr.write(`error [${err.code}]: ${err.message}\n`);
    }
    process.exit(err.exitCode);
  });
