import { Drive } from '@internxt/sdk';
import type { AgentConfig } from './config.js';
import { appDetails } from './session.js';
import { AgentError } from './errors.js';

/** Payloads confirmed against the OpenAPI schema (MoveFolderDto / MoveFileDto). */
export interface MovePayload {
  destinationFolder: string;
  name?: string;
}

/**
 * Drive repository: path resolution, cached folder listing and storage operations.
 * All identifiers are UUIDs over the wire (same endpoints drive-web calls); human paths are
 * resolved client-side and memoized briefly (minimal latency for agent loops).
 */

export interface DriveFolderItem {
  kind: 'folder';
  uuid: string;
  name: string;
  createdAt: string | number | undefined;
  updatedAt: string | number | undefined;
}

export interface DriveFileItem {
  kind: 'file';
  uuid: string;
  name: string; // plainName + "." + type (extension), when present
  size: number;
  createdAt: string | number | undefined;
  updatedAt: string | number | undefined;
}

export type DriveItem = DriveFolderItem | DriveFileItem;

export type ResolvedItem = { uuid: string; kind: 'folder' } | { uuid: string; kind: 'file' };

interface CacheEntry {
  at: number;
  folders: Map<string, string>; // lowercase plainName -> uuid
  files: Map<string, string>; // lowercase "name.ext" -> uuid
}

const CACHE_TTL_MS = 60_000;
const PAGE_LIMIT = 1000; // server max page size, same as the official CLI

interface RawFolderRow {
  uuid: string;
  plainName?: string | null;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
}

interface RawFileRow {
  uuid: string;
  plainName?: string | null;
  type?: string | null;
  size?: number | null;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
}

export class DriveRepo {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly config: AgentConfig,
    private readonly getToken: () => string,
  ) {}

  /** Fresh client per call so rotated tokens (auth retry) always flow through. */
  private get storage(): Drive.Storage {
    return Drive.Storage.client(this.config.driveApiUrl, appDetails(this.config), { token: this.getToken() });
  }

  /** Drop cached listings (call after any mutating operation). */
  invalidate(uuid?: string): void {
    if (uuid) this.cache.delete(uuid);
    else this.cache.clear();
  }

  private async listAll<T>(
    page: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string | null }>,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const res = await page(cursor);
      out.push(...res.items);
      cursor = res.nextCursor && res.nextCursor.length > 0 ? res.nextCursor : undefined;
    } while (cursor);
    return out;
  }

  /** List one folder's children (folders + files in parallel), bypassing cache. */
  async listFolder(uuid: string): Promise<{ folders: DriveFolderItem[]; files: DriveFileItem[] }> {
    const [folderRows, fileRows] = await Promise.all([
      this.listAll(async (cursor) => {
        const [promise] = this.storage.getFolderFoldersByUuidWithCursor(uuid, { limit: PAGE_LIMIT, order: 'ASC', cursor });
        const { folders, nextCursor } = await promise;
        return { items: folders as RawFolderRow[], nextCursor };
      }),
      this.listAll(async (cursor) => {
        const [promise] = this.storage.getFolderFilesByUuidWithCursor(uuid, { limit: PAGE_LIMIT, order: 'ASC', cursor });
        const { files, nextCursor } = await promise;
        return { items: files as unknown as RawFileRow[], nextCursor };
      }),
    ]);
    return {
      folders: folderRows.map((f) => ({
        kind: 'folder' as const,
        uuid: f.uuid,
        name: f.plainName ?? '',
        createdAt: f.createdAt ?? undefined,
        updatedAt: f.updatedAt ?? undefined,
      })),
      files: fileRows.map((f) => ({
        kind: 'file' as const,
        uuid: f.uuid,
        name: (f.type ?? '').length > 0 ? `${f.plainName ?? ''}.${f.type}` : f.plainName ?? '',
        size: Number(f.size ?? 0),
        createdAt: f.createdAt ?? undefined,
        updatedAt: f.updatedAt ?? undefined,
      })),
    };
  }

  /** Populate/read the name->uuid cache for a folder. */
  private async indexedChildren(uuid: string): Promise<{ folders: Map<string, string>; files: Map<string, string> }> {
    const hit = this.cache.get(uuid);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { folders: hit.folders, files: hit.files };
    }
    const { folders, files } = await this.listFolder(uuid);
    const folderMap = new Map<string, string>();
    const fileMap = new Map<string, string>();
    for (const f of folders) folderMap.set(f.name.toLowerCase(), f.uuid);
    for (const f of files) fileMap.set(f.name.toLowerCase(), f.uuid);
    // Same-name siblings would overwrite here; agents operating by id are unaffected, and
    // path resolution surfaces a wrong-but-existing match, so keep it simple (same as web).
    this.cache.set(uuid, { at: Date.now(), folders: folderMap, files: fileMap });
    return { folders: folderMap, files: fileMap };
  }

  /**
   * Resolve a slash-separated path from the account root. Returns uuid and kind.
   * The LAST segment may be a file; intermediate ones must be folders.
   */
  async resolvePath(rootFolderId: string, path: string): Promise<ResolvedItem> {
    const segments = path.split('/').map((s) => s.trim()).filter((s) => s.length > 0 && s !== '.');
    if (segments.length === 0) return { uuid: rootFolderId, kind: 'folder' };

    let current = rootFolderId;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] as string;
      const key = seg.toLowerCase();
      const { folders, files } = await this.indexedChildren(current);
      const folderUuid = folders.get(key);
      if (folderUuid) {
        if (i === segments.length - 1) return { uuid: folderUuid, kind: 'folder' };
        current = folderUuid;
        continue;
      }
      const fileUuid = files.get(key);
      if (fileUuid && i === segments.length - 1) return { uuid: fileUuid, kind: 'file' };
      throw new AgentError('PATH_NOT_FOUND', `Path segment not found: "${seg}" (in path "${path}")`, {
        details: { segment: seg, index: i },
      });
    }
    return { uuid: current, kind: 'folder' };
  }

  /** Require the path to resolve to a folder, or throw PATH_NOT_FOUND. */
  async resolveFolder(rootFolderId: string, path: string): Promise<string> {
    const res = await this.resolvePath(rootFolderId, path);
    if (res.kind !== 'folder') {
      throw new AgentError('PATH_NOT_FOUND', `"${path}" is a file, not a folder`, { details: { path } });
    }
    return res.uuid;
  }

  async createFolder(parentUuid: string, name: string): Promise<string> {
    const [promise] = this.storage.createFolderByUuid({ parentFolderUuid: parentUuid, plainName: name });
    const created = await promise;
    this.invalidate(parentUuid);
    return created.uuid;
  }

  /** Trash a file or folder (same addItemsToTrash drive-web calls). */
  async trash(uuid: string, kind: 'file' | 'folder'): Promise<void> {
    const trash = Drive.Trash.client(this.config.driveApiUrl, appDetails(this.config), { token: this.getToken() });
    await trash.addItemsToTrash({ items: [{ uuid, type: kind }] });
    this.invalidate();
  }

  /** Restore = move back to the original parent (drive-web restore semantics). */
  async restore(uuid: string, kind: 'file' | 'folder', parentUuid: string, name?: string): Promise<void> {
    await this.move(uuid, kind, parentUuid, name);
  }

  /** Move (and optionally rename) a file/folder via PATCH (MoveFolderDto / MoveFileDto). */
  async move(uuid: string, kind: 'file' | 'folder', destinationFolder: string, name?: string): Promise<void> {
    const payload: MovePayload = { destinationFolder, ...(name !== undefined ? { name } : {}) };
    if (kind === 'folder') await this.storage.moveFolderByUuid(uuid, payload);
    else await this.storage.moveFileByUuid(uuid, payload);
    this.invalidate();
  }

  /** Rename in place via the meta endpoints drive-web uses. */
  async rename(uuid: string, kind: 'file' | 'folder', newName: string): Promise<void> {
    if (kind === 'folder') await this.storage.updateFolderNameWithUUID({ folderUuid: uuid, name: newName });
    else await this.storage.updateFileNameWithUUID({ fileUuid: uuid, name: newName });
    this.invalidate();
  }

  /** Permanently delete trashed items (irreversible). */
  async deletePermanent(items: Array<{ uuid: string; type: 'file' | 'folder' }>): Promise<void> {
    const trash = Drive.Trash.client(this.config.driveApiUrl, appDetails(this.config), { token: this.getToken() });
    await trash.deleteItemsPermanentlyByUUID({ items });
    this.invalidate();
  }

  /** Empty the whole trash (irreversible). */
  async clearTrash(): Promise<void> {
    const trash = Drive.Trash.client(this.config.driveApiUrl, appDetails(this.config), { token: this.getToken() });
    await trash.clearTrash();
  }

  /** List trashed items via the paginated endpoint drive-web uses. */
  async listTrash(): Promise<{ folders: DriveFolderItem[]; files: DriveFileItem[] }> {
    const trash = Drive.Trash.client(this.config.driveApiUrl, appDetails(this.config), { token: this.getToken() });
    const [filesRes, foldersRes] = await Promise.all([
      trash.getTrashedItemsSorted(50, 0, 'files', true, 'plainName', 'ASC'),
      trash.getTrashedItemsSorted(50, 0, 'folders', true, 'plainName', 'ASC'),
    ]);
    const rows = filesRes as { result?: Array<{ uuid: string; plainName?: string | null; type?: string | null; size?: number | string | null }> };
    const rowsF = foldersRes as { result?: Array<{ uuid: string; plainName?: string | null }> };
    return {
      folders: (rowsF.result ?? []).map((f) => ({ kind: 'folder' as const, uuid: f.uuid, name: f.plainName ?? '', createdAt: undefined, updatedAt: undefined })),
      files: (rows.result ?? []).map((f) => ({
        kind: 'file' as const,
        uuid: f.uuid,
        name: (f.type ?? '').length > 0 ? `${f.plainName ?? ''}.${f.type}` : f.plainName ?? '',
        size: Number(f.size ?? 0),
        createdAt: undefined,
        updatedAt: undefined,
      })),
    };
  }

  /** Account quota/usage (UsageResponseV2 shape). */
  async quota(): Promise<{ total: number; used: number }> {
    const usage = await this.storage.spaceUsageV2();
    return { total: Number(usage.total), used: Number(usage.drive ?? 0) + Number(usage.backups ?? 0) };
  }

  /** Search items by name via the fuzzy search drive-web uses (POST /fuzzy/{search}). */
  async search(term: string): Promise<Array<{ uuid: string; name: string; kind: 'file' | 'folder'; size: number }>> {
    const [promise] = this.storage.getGlobalSearchItems(term);
    const res = (await promise) as unknown as {
      data?: Array<{ itemId: string; itemType: string; item?: { plainName?: string; type?: string; size?: string } }>;
    };
    const results = Array.isArray(res) ? res : (res.data ?? []);
    return results.map((r) => {
      const kind: 'file' | 'folder' = r.itemType === 'folder' ? 'folder' : 'file';
      const base = r.item?.plainName ?? '';
      const ext = r.item?.type ?? '';
      const name = kind === 'file' && ext.length > 0 ? `${base}.${ext}` : base;
      return { uuid: r.itemId, name, kind, size: Number(r.item?.size ?? 0) };
    });
  }

  /** Find an existing file by full name (name.ext) in a folder, or null. */
  async findFileByName(folderUuid: string, fullName: string): Promise<{ uuid: string } | null> {
    const { files } = await this.indexedChildren(folderUuid);
    const uuid = files.get(fullName.toLowerCase());
    return uuid ? { uuid } : null;
  }

  /** Fetch file metadata (needs fileId + size for transfers). */
  async getFileMeta(uuid: string): Promise<{ fileId: string; size: number; name: string; folderUuid: string | null }> {
    const [promise] = this.storage.getFile(uuid);
    const meta = (await promise) as {
      uuid: string;
      fileId: string | null;
      size: number | string;
      plainName?: string | null;
      type?: string | null;
      folderUuid?: string | null;
    };
    if (!meta.fileId) throw new AgentError('PATH_NOT_FOUND', `file has no network id (uuid ${uuid})`);
    return {
      fileId: meta.fileId,
      size: Number(meta.size ?? 0),
      name: (meta.type ?? '').length > 0 ? `${meta.plainName ?? ''}.${meta.type}` : meta.plainName ?? '',
      folderUuid: meta.folderUuid ?? null,
    };
  }
}
