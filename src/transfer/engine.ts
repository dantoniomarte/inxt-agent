import { createReadStream, createWriteStream } from 'node:fs';
import { createDecipheriv, createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Environment } from '@internxt/inxt-js';
import { mnemonicToSeed } from 'bip39';
import { Drive, Network as NetworkModule } from '@internxt/sdk';
import type { GetDownloadLinksResponse } from '@internxt/sdk/dist/network/types.js';
import type { AgentConfig } from '../core/config.js';
import { appDetails } from '../core/session.js';
import { AgentError, sanitizeMessage } from '../core/errors.js';
import type { StoredUser } from '../core/credentials.js';

/**
 * Transfer engine: E2EE uploads and downloads over the Internxt network.
 *
 * Upload (Aes03, same as drive-web/CLI): Environment.upload (inxt-js) encrypts the stream
 *   client-side (key = GenerateFileKey(mnemonic, bucketId, index), AES-256-CTR, HMAC,
 *   multipart for big files, presigned S3 URLs) -> network fileId -> drive entry via
 *   POST /files (CreateFileDto).
 * Download (same as the official CLI's NetworkFacade): getDownloadLinks -> shard streams
 *   fetched in order -> AES-256-CTR decipher (key derived from mnemonic+bucket+index) piped
 *   to the destination. Plaintext never leaves the machine unencrypted; the mnemonic stays local.
 */

/**
 * Key derivation EXACTLY as drive-web does it (app/network/crypto.ts), verified against the
 * real account: seed = bip39 mnemonicToSeed, bucketKey = SHA512(seed || bucketId bytes),
 * fileKey = SHA512(bucketKey[0..32] || index)[0..32], iv = index[0..16].
 */
async function deriveFileKey(mnemonic: string, bucketId: string, index: Buffer): Promise<Buffer> {
  const seed = await mnemonicToSeed(mnemonic);
  const sha512 = (key: Buffer, data: Buffer): Buffer => createHash('sha512').update(key).update(data).digest();
  const bucketKey = sha512(seed, Buffer.from(bucketId, 'hex'));
  return sha512(bucketKey.subarray(0, 32), index).subarray(0, 32);
}

const FETCH_TIMEOUT_MS = 30_000;

export interface UploadResult {
  networkFileId: string;
  driveUuid: string;
  size: number;
}

export class TransferEngine {
  private readonly env: Environment;
  private readonly network: NetworkModule.Network;

  constructor(
    private readonly config: AgentConfig,
    private readonly user: StoredUser,
  ) {
    this.env = new Environment({
      bridgeUrl: config.networkUrl,
      bridgeUser: user.bridgeUser,
      bridgePass: user.userId, // NetworkCredentials contract: pass = userId (client hashes it)
      encryptionKey: user.mnemonic,
      appDetails: appDetails(config),
    });
    // NetworkCredentials contract: bridgePass = userId; Environment hashes it internally
    // (sha256), but the raw Network client expects the ALREADY-hashed value (same as the
    // official CLI's SdkManager.getNetwork -> getAuthFromCredentials).
    const hashedUserId = createHash('sha256').update(user.userId).digest('hex');
    this.network = NetworkModule.Network.client(config.networkUrl, appDetails(config), {
      bridgeUser: user.bridgeUser,
      userId: hashedUserId,
    });
  }

  /** Upload a local file into `folderUuid` as `name` (basename with extension). */
  async uploadFile(opts: {
    token: string;
    localPath: string;
    size: number;
    folderUuid: string;
    name: string;
    abortSignal?: AbortSignal;
    onProgress?: (pct: number) => void;
  }): Promise<UploadResult> {
    if (opts.size <= 0) {
      throw new AgentError('INVALID_ARGUMENT', 'Empty-file upload is not supported yet (network rejects size 0)');
    }
    const { plainName, type } = splitName(opts.name);
    const source = createReadStream(opts.localPath);

    let networkFileId: string;
    try {
      networkFileId = await this.env.upload(this.user.bucket, {
        source: source as unknown as Readable,
        fileSize: opts.size,
        progressCallback: (p: number) => opts.onProgress?.(Math.round(p * 100)),
        abortSignal: opts.abortSignal,
      });
    } catch (e) {
      source.destroy();
      throw wrapTransferError(e, 'upload');
    }

    if (opts.abortSignal?.aborted) throw new AgentError('ABORTED', 'Upload aborted');

    try {
      const storage = Drive.Storage.client(this.config.driveApiUrl, appDetails(this.config), { token: opts.token });
      const created = (await storage.createFileEntryByUuid({
        bucket: this.user.bucket,
        fileId: networkFileId,
        encryptVersion: '03-aes',
        folderUuid: opts.folderUuid,
        size: opts.size,
        plainName,
        ...(type !== undefined ? { type } : {}),
      })) as unknown as { uuid: string };
      return { networkFileId, driveUuid: created.uuid, size: opts.size };
    } catch (e) {
      throw wrapTransferError(e, 'register-file');
    }
  }

  /** Stream-decrypt a network file into `destinationPath`. */
  async downloadToFile(opts: {
    fileId: string;
    destinationPath: string;
    abortSignal?: AbortSignal;
    onProgress?: (pct: number) => void;
  }): Promise<void> {
    let links: GetDownloadLinksResponse;
    try {
      links = await this.network.getDownloadLinks(this.user.bucket, opts.fileId);
    } catch (e) {
      throw wrapTransferError(e, 'download-links');
    }

    if (!links.version || links.version === 1) {
      throw new AgentError('CRYPTO', 'Legacy v1 file encryption is not supported');
    }

    const indexHex = Buffer.isBuffer(links.index) ? links.index.toString('hex') : String(links.index);
    const index = Buffer.from(indexHex, 'hex');
    const key = await deriveFileKey(this.user.mnemonic, this.user.bucket, index);
    const iv = index.subarray(0, 16);

    const shards = [...links.shards].sort((a, b) => a.index - b.index);
    const totalBytes = links.size ?? shards.reduce((acc, s) => acc + (s.size ?? 0), 0);
    let received = 0;
    let lastPct = -1;

    const destination: Writable = createWriteStream(opts.destinationPath);
    const onAbort = (): void => {
      destination.destroy(new AgentError('ABORTED', 'Download aborted'));
    };
    opts.abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      for (const shard of shards) {
        if (!shard.url) throw new AgentError('SERVER', 'Download link missing URL for a shard');
        const res = await fetch(shard.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok || !res.body) {
          throw new AgentError('SERVER', `Shard download failed (${res.status})`, { status: res.status });
        }
        const stream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
        stream.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.round((received / totalBytes) * 100);
            if (pct !== lastPct) {
              lastPct = pct;
              opts.onProgress?.(pct);
            }
          }
        });
        // Sequential decryption: shard N+1 bytes continue the CTR stream after shard N.
        const decipher = createDecipheriv('aes-256-ctr', key, iv);
        await pipeline(stream, decipher, destination, { end: false });
      }
      await new Promise<void>((resolve, reject) => {
        if (destination.writableFinished) resolve();
        else {
          destination.on('finish', () => resolve());
          destination.on('error', reject);
          destination.end();
        }
      });
    } catch (e) {
      throw wrapTransferError(e, 'download');
    } finally {
      opts.abortSignal?.removeEventListener('abort', onAbort);
    }
  }
}

export function splitName(fullName: string): { plainName: string; type?: string } {
  const dot = fullName.lastIndexOf('.');
  if (dot <= 0 || dot === fullName.length - 1) return { plainName: fullName };
  const type = fullName.slice(dot + 1);
  // drive-web's model: type is the short alphanumeric extension; otherwise keep full name
  if (!/^[A-Za-z0-9]{1,12}$/.test(type)) return { plainName: fullName };
  return { plainName: fullName.slice(0, dot), type };
}

function wrapTransferError(e: unknown, phase: string): AgentError {
  if (e instanceof AgentError) return e;
  const err = e as Error & { response?: { status?: number } };
  const status = err.response?.status;
  const msg = sanitizeMessage(err.message || String(e));
  if (status === 402) return new AgentError('QUOTA_EXCEEDED', `Transfer rejected (plan/size limit) during ${phase}`, { status });
  if (status === 429) return new AgentError('RATE_LIMITED', `Rate limited during ${phase}`, { status });
  return new AgentError('NETWORK', `Transfer failed during ${phase}: ${msg}`);
}
