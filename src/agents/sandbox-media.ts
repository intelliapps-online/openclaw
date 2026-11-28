import { createWriteStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { openFileWithinRoot } from "../infra/fs-safe.js";
import { MAX_DOCUMENT_BYTES } from "../media/constants.js";

const HTTP_URL_RE = /^https?:\/\//i;
const STAGED_MEDIA_DIR_PREFIX = "openclaw-sandbox-media-";
const STAGED_MEDIA_TTL_MS = 30 * 60 * 1000;

export function isRemoteMediaUrl(value: string): boolean {
  return HTTP_URL_RE.test(value.trim());
}

// Staged copies keyed by the identity of the file they were copied from, so the
// same unchanged sandbox file maps to one copy (keeps de-duplication by URL working).
const stagedByIdentity = new Map<string, Promise<string>>();

function scheduleStagedMediaRemoval(dir: string, identity: string) {
  const timer = setTimeout(() => {
    stagedByIdentity.delete(identity);
    void fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }, STAGED_MEDIA_TTL_MS);
  timer.unref?.();
}

async function copyOpenedFile(params: {
  handle: FileHandle;
  size: number;
  realPath: string;
  identity: string;
}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), STAGED_MEDIA_DIR_PREFIX));
  scheduleStagedMediaRemoval(dir, params.identity);
  const dest = path.join(dir, path.basename(params.realPath) || "file");
  const out = createWriteStream(dest, { flags: "wx", mode: 0o600 });
  if (params.size === 0) {
    await new Promise<void>((resolve, reject) => {
      out.once("finish", resolve);
      out.once("error", reject);
      out.end();
    });
    return dest;
  }
  // Bound the copy to the size seen at open so a growing file cannot stream forever.
  await pipeline(
    params.handle.createReadStream({ start: 0, end: params.size - 1, autoClose: false }),
    out,
  );
  return dest;
}

/**
 * Copy a file that lives inside a sandbox workspace into a fresh gateway-owned
 * temp directory and return the copy's path.
 *
 * The source is opened once, inside the sandbox root (no symlink escapes, same
 * inode as the resolved path), and the copy is made from that handle. Delivery
 * then reads the copy, so the sandbox cannot redirect it to a host file by
 * swapping the path after validation, and the sandbox directory itself never has
 * to be a delivery root.
 */
export async function stageSandboxedMediaFile(params: {
  filePath: string;
  sandboxRoot: string;
}): Promise<string> {
  const rootDir = path.resolve(params.sandboxRoot);
  const relativePath = path.relative(rootDir, path.resolve(params.filePath));
  const { handle, realPath, stat } = await openFileWithinRoot({ rootDir, relativePath });
  try {
    if (stat.size > MAX_DOCUMENT_BYTES) {
      throw new Error(
        `Sandbox media exceeds ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))}MB: ${params.filePath}`,
      );
    }
    const identity = [realPath, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(
      "\0",
    );
    let pending = stagedByIdentity.get(identity);
    if (!pending) {
      pending = copyOpenedFile({ handle, size: stat.size, realPath, identity });
      stagedByIdentity.set(identity, pending);
      pending.catch(() => stagedByIdentity.delete(identity));
    }
    return await pending;
  } finally {
    await handle.close().catch(() => {});
  }
}
