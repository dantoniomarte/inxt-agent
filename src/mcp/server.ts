#!/usr/bin/env node
/**
 * inxt-agent MCP server (stdio) — exposes the user's Internxt Drive to MCP agents
 * (pi, hermes, Claude, ...) with the same core as the CLI.
 *
 * Tools are annotated per MCP spec: readOnlyHint for queries, destructiveHint for
 * irreversible operations. Destructive tools also require `confirm: true` in the input,
 * because annotations are hints, not gates.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { stat } from 'node:fs/promises';
import { loadConfig } from '../core/config.js';
import { hasCredentials } from '../core/credentials.js';
import { getSession } from '../core/auth.js';
import { performLogin, performLogout, refreshSession, completeLoginFromCallbackUrl } from '../core/auth.js';
import { buildLoginUrl } from '../core/login.js';
import { DriveRepo } from '../core/drive.js';
import { TransferEngine } from '../transfer/engine.js';
import { AgentError, isAgentError, toAgentError } from '../core/errors.js';

interface Ctx {
  config: ReturnType<typeof loadConfig>;
  repo: DriveRepo;
  token: string;
}

/** One context per call: commands re-read credentials so rotated tokens flow through. */
async function ctx(): Promise<Ctx> {
  const config = loadConfig();
  const creds = await getSession(config);
  return { config, token: creds.token, repo: new DriveRepo(config, () => creds.token) };
}

/** Run an op with the same 401-retry-once semantics as the CLI. */
async function withRetry<T>(args: ParsedLogin, op: (c: Ctx) => Promise<T>): Promise<T> {
  try {
    return await op(await ctx());
  } catch (e) {
    const err = isAgentError(e) ? e : toAgentError(e);
    if (err.code !== 'AUTH_EXPIRED') throw err;
    const config = loadConfig();
    const creds = await getSession(config);
    await refreshSession(config, creds);
    return op(await ctx());
  }
}

type ParsedLogin = { port?: number };

const server = new McpServer({ name: 'inxt-agent', version: '0.1.0' });

function text(value: unknown): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(e: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const err = isAgentError(e) ? e : toAgentError(e);
  return { content: [{ type: 'text', text: JSON.stringify(err.toJSON()) }], isError: true };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- internal wrapper; the SDK validates via zod at runtime
function register(name: string, description: string, schema: any, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }, handler: (args: any) => Promise<unknown>): void {
  server.registerTool(
    name,
    { description, inputSchema: schema, annotations: { openWorldHint: false, ...annotations } },
    async (args: any) => {
      try {
        return text(await handler(args));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}

// ---- session ----
register(
  'inxt_status',
  'Show Internxt session state (redacted) and storage quota. Returns loggedIn:false when no credentials exist yet.',
  {},
  { readOnlyHint: true, idempotentHint: true },
  async () => {
    const config = loadConfig();
    if (!(await hasCredentials(config))) return { loggedIn: false };
    const creds = await getSession(config);
    let quota: unknown = null;
    try {
      quota = await new DriveRepo(config, () => creds.token).quota();
    } catch {
      // quota is informational; session state is the point of this tool
    }
    return { loggedIn: true, email: creds.user.email, savedAt: creds.savedAt, quota };
  },
);

register(
  'inxt_login',
  'Authorize Internxt access via browser (universal-link). Prints a URL the HUMAN must open and approve. Only call when the user explicitly asks to connect their Internxt account.',
  { port: z.number().int().min(0).max(65535).optional() },
  { readOnlyHint: false },
  async (args: ParsedLogin) => {
    const config = loadConfig();
    let loginUrl: string | undefined;
    const { user } = await performLogin(config, args.port ?? 0, (url) => {
      loginUrl = url;
      process.stderr.write(`Open this URL to authorize inxt-agent:\n  ${url}\n`);
    });
    return { loggedIn: true, email: user.email, loginUrl };
  },
);

register(
  'inxt_login_remote',
  'Headless login step 1: returns the Internxt authorization URL. The HUMAN opens it on any machine with a browser, logs in, and copies the resulting (failing) localhost URL from the address bar. Then call inxt_login_complete with that URL. Use when this machine has no browser.',
  {},
  { readOnlyHint: true },
  async () => {
    const config = loadConfig();
    return {
      loginUrl: buildLoginUrl(config, 1),
      instructions: [
        '1. Open loginUrl on any machine with a browser and log in to your Internxt account.',
        '2. The browser will fail to connect to 127.0.0.1:1 - that is expected.',
        '3. Copy the FULL URL from the address bar.',
        '4. Call inxt_login_complete with pasted_url set to that URL.',
      ],
    };
  },
);

register(
  'inxt_login_complete',
  'Headless login step 2: complete the session with the callback URL the human pasted (from the browser address bar after step 1). The pasted URL contains credentials: it is never echoed back or logged.',
  { pasted_url: z.string().min(1) },
  {},
  async (args: { pasted_url: string }) => {
    const config = loadConfig();
    const { user } = await completeLoginFromCallbackUrl(config, args.pasted_url);
    return { loggedIn: true, email: user.email, rootFolderId: user.rootFolderId };
  },
);

register(
  'inxt_logout',
  'Log out: invalidate the session server-side (best effort) and wipe local credentials.',
  {},
  {},
  async () => {
    await performLogout(loadConfig());
    return { loggedOut: true };
  },
);

// ---- read ----
register('inxt_ls', 'List a remote folder (or stat a file). Paths are slash-separated from the drive root, e.g. "Docs/Reports".', { path: z.string().optional() }, { readOnlyHint: true, idempotentHint: true }, async (args: { path?: string }) => {
  return withRetry({}, async (c) => {
    const creds = await getSession(c.config);
    const resolved = await c.repo.resolvePath(creds.user.rootFolderId, args.path ?? '');
    if (resolved.kind === 'file') {
      const meta = await c.repo.getFileMeta(resolved.uuid);
      return { path: args.path ?? '', kind: 'file', uuid: resolved.uuid, size: meta.size };
    }
    const { folders, files } = await c.repo.listFolder(resolved.uuid);
    return {
      path: args.path ?? '',
      items: [...folders, ...files].map((it) => ({ kind: it.kind, name: it.name, uuid: it.uuid, ...(it.kind === 'file' ? { size: it.size } : {}) })),
    };
  });
});

register('inxt_search', 'Search files and folders by name (server-side fuzzy search).', { term: z.string().min(1) }, { readOnlyHint: true }, async (args: { term: string }) => {
  return withRetry({}, (c) => c.repo.search(args.term));
});

register('inxt_quota', 'Show account storage usage and limits.', {}, { readOnlyHint: true, idempotentHint: true }, async () => {
  return withRetry({}, (c) => c.repo.quota());
});

// ---- write ----
register('inxt_mkdir', 'Create a folder (recursive, like mkdir -p).', { path: z.string().min(1) }, {}, async (args: { path: string }) => {
  return withRetry({}, async (c) => {
    const creds = await getSession(c.config);
    const segments = args.path.split('/').map((s) => s.trim()).filter((s) => s.length > 0 && s !== '.');
    let current = creds.user.rootFolderId;
    for (const seg of segments) {
      try {
        const res = await c.repo.resolvePath(current, seg);
        if (res.kind !== 'folder') throw new AgentError('ALREADY_EXISTS', `"${seg}" already exists as a file`);
        current = res.uuid;
      } catch (e) {
        if (isAgentError(e) && e.code === 'PATH_NOT_FOUND') current = await c.repo.createFolder(current, seg);
        else throw e;
      }
    }
    return { created: args.path, uuid: current };
  });
});

register('inxt_upload', 'Upload a local file to the Drive (E2EE). Destination is a remote dir or a full remote file path. Overwriting an existing file requires confirm:true (the old file goes to the trash).', {
  local_path: z.string().min(1),
  remote_path: z.string().min(1),
  confirm: z.boolean().optional(),
}, {}, async (args: { local_path: string; remote_path: string; confirm?: boolean }) => {
  return withRetry({}, async (c) => {
    const creds = await getSession(c.config);
    const st = await stat(args.local_path).catch(() => undefined);
    if (!st?.isFile()) throw new AgentError('INVALID_ARGUMENT', `local path is not a file: ${args.local_path}`);
    const slash = args.remote_path.lastIndexOf('/');
    const parentPath = slash > 0 ? args.remote_path.slice(0, slash) : '';
    const fileName = slash >= 0 ? args.remote_path.slice(slash + 1) : args.remote_path;
    if (fileName.length === 0) throw new AgentError('INVALID_ARGUMENT', 'remote file name is empty');
    const parentUuid = await c.repo.resolveFolder(creds.user.rootFolderId, parentPath);
    const existing = await c.repo.findFileByName(parentUuid, fileName);
    if (existing) {
      if (!args.confirm) throw new AgentError('CONFIRMATION_REQUIRED', `remote file exists: ${args.remote_path} (pass confirm:true to overwrite via trash)`);
      await c.repo.trash(existing.uuid, 'file');
    }
    const engine = new TransferEngine(c.config, creds.user);
    const result = await engine.uploadFile({ token: creds.token, localPath: args.local_path, size: st.size, folderUuid: parentUuid, name: fileName });
    return { uploaded: args.remote_path, uuid: result.driveUuid, size: st.size };
  });
});

register('inxt_download', 'Download a remote file (decrypts locally). local_path is the destination file path.', {
  remote_path: z.string().min(1),
  local_path: z.string().min(1),
}, {}, async (args: { remote_path: string; local_path: string }) => {
  return withRetry({}, async (c) => {
    const creds = await getSession(c.config);
    const resolved = await c.repo.resolvePath(creds.user.rootFolderId, args.remote_path);
    if (resolved.kind !== 'file') throw new AgentError('PATH_NOT_FOUND', `remote path is not a file: ${args.remote_path}`);
    const meta = await c.repo.getFileMeta(resolved.uuid);
    const engine = new TransferEngine(c.config, creds.user);
    await engine.downloadToFile({ fileId: meta.fileId, destinationPath: args.local_path });
    return { downloaded: args.remote_path, to: args.local_path, size: meta.size };
  });
});

register('inxt_mv', 'Move (and optionally rename) a file or folder. If remote_dest does not exist, its last segment is the new name.', {
  remote_src: z.string().min(1),
  remote_dest: z.string().min(1),
}, {}, async (args: { remote_src: string; remote_dest: string }) => {
  return withRetry({}, async (c) => {
    const creds = await getSession(c.config);
    const src = await c.repo.resolvePath(creds.user.rootFolderId, args.remote_src);
    const slash = args.remote_dest.lastIndexOf('/');
    const parentPath = slash > 0 ? args.remote_dest.slice(0, slash) : '';
    const leaf = slash >= 0 ? args.remote_dest.slice(slash + 1) : args.remote_dest;
    const parentUuid = await c.repo.resolveFolder(creds.user.rootFolderId, parentPath);
    let destination = parentUuid;
    let renameTo: string | undefined;
    try {
      const existing = await c.repo.resolvePath(creds.user.rootFolderId, args.remote_dest);
      if (existing.kind !== 'folder') throw new AgentError('ALREADY_EXISTS', `destination exists as a file: ${args.remote_dest}`);
      destination = existing.uuid;
    } catch (e) {
      if (isAgentError(e) && e.code === 'PATH_NOT_FOUND') renameTo = leaf;
      else throw e;
    }
    await c.repo.move(src.uuid, src.kind, destination, renameTo);
    return { moved: args.remote_src, to: args.remote_dest, renamed: renameTo ?? null };
  });
});

register('inxt_rename', 'Rename a file or folder in place (new name must be a bare name, no slashes).', {
  remote_path: z.string().min(1),
  new_name: z.string().min(1),
}, {}, async (args: { remote_path: string; new_name: string }) => {
  return withRetry({}, async (c) => {
    const creds = await getSession(c.config);
    const resolved = await c.repo.resolvePath(creds.user.rootFolderId, args.remote_path);
    await c.repo.rename(resolved.uuid, resolved.kind, args.new_name);
    return { renamed: args.remote_path, to: args.new_name };
  });
});

// ---- destructive ----
register('inxt_rm', 'Move a file or folder to the trash (recoverable). Requires confirm:true.', {
  remote_path: z.string().min(1),
  confirm: z.boolean(),
}, { destructiveHint: true }, async (args: { remote_path: string; confirm: boolean }) => {
  if (!args.confirm) throw new AgentError('CONFIRMATION_REQUIRED', 'pass confirm:true to move to trash');
  return withRetry({}, async (c) => {
    const creds = await getSession(c.config);
    const resolved = await c.repo.resolvePath(creds.user.rootFolderId, args.remote_path);
    await c.repo.trash(resolved.uuid, resolved.kind);
    return { trashed: args.remote_path, kind: resolved.kind };
  });
});

register('inxt_trash_list', 'List trashed items.', {}, { readOnlyHint: true }, async () => {
  return withRetry({}, (c) => c.repo.listTrash());
});

register('inxt_restore', 'Restore a trashed item to the Drive root (or a given folder). Requires confirm:true.', {
  name: z.string().min(1),
  destination_path: z.string().optional(),
  confirm: z.boolean(),
}, {}, async (args: { name: string; destination_path?: string; confirm: boolean }) => {
  if (!args.confirm) throw new AgentError('CONFIRMATION_REQUIRED', 'pass confirm:true to restore');
  return withRetry({}, async (c) => {
    const creds = await getSession(c.config);
    const { folders, files } = await c.repo.listTrash();
    const base = args.name.split('/').pop() ?? args.name;
    const item = folders.find((f) => f.name.toLowerCase() === base.toLowerCase()) ?? files.find((f) => f.name.toLowerCase() === base.toLowerCase());
    if (!item) throw new AgentError('PATH_NOT_FOUND', `"${base}" not found in trash`);
    const dest = args.destination_path ? await c.repo.resolveFolder(creds.user.rootFolderId, args.destination_path) : creds.user.rootFolderId;
    await c.repo.restore(item.uuid, item.kind, dest, item.name);
    return { restored: item.name, kind: item.kind, to: args.destination_path ?? 'root' };
  });
});

register('inxt_purge', 'Permanently delete a trashed item. IRREVERSIBLE. Requires confirm:true.', {
  name: z.string().min(1),
  confirm: z.boolean(),
}, { destructiveHint: true }, async (args: { name: string; confirm: boolean }) => {
  if (!args.confirm) throw new AgentError('CONFIRMATION_REQUIRED', 'pass confirm:true to PERMANENTLY delete');
  return withRetry({}, async (c) => {
    const { folders, files } = await c.repo.listTrash();
    const base = args.name.split('/').pop() ?? args.name;
    const item = folders.find((f) => f.name.toLowerCase() === base.toLowerCase()) ?? files.find((f) => f.name.toLowerCase() === base.toLowerCase());
    if (!item) throw new AgentError('PATH_NOT_FOUND', `"${base}" not found in trash`);
    await c.repo.deletePermanent([{ uuid: item.uuid, type: item.kind }]);
    return { deletedPermanently: item.name, kind: item.kind };
  });
});

register('inxt_empty_trash', 'Empty the whole trash. IRREVERSIBLE. Requires confirm:true.', {
  confirm: z.boolean(),
}, { destructiveHint: true }, async (args: { confirm: boolean }) => {
  if (!args.confirm) throw new AgentError('CONFIRMATION_REQUIRED', 'pass confirm:true to empty the trash');
  return withRetry({}, async (c) => {
    await c.repo.clearTrash();
    return { emptied: true };
  });
});

await server.connect(new StdioServerTransport());
