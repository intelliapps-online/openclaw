import { randomBytes } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

export const SERVICE_FILE_MODE = 0o600;
export const SERVICE_DIR_MODE = 0o700;

/**
 * Service definitions embed OPENCLAW_GATEWAY_TOKEN and config env vars, so other local users
 * must never be able to read them. The content is written to a fresh owner-only temp file
 * (O_EXCL) and renamed over the target: it never exists in a file with looser permissions, and an
 * older world-readable file is replaced rather than rewritten in place (which would keep its mode).
 */
export async function writeServiceFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: SERVICE_DIR_MODE });
  if (process.platform === "win32") {
    // POSIX modes do not apply; the per-user profile ACL governs access. Rewriting in place also
    // keeps working while cmd.exe holds the running task script open.
    await fs.writeFile(filePath, content, "utf8");
    return;
  }
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await fs.open(tmpPath, "wx", SERVICE_FILE_MODE);
  try {
    // The umask can only drop bits; set the exact mode on the handle we created.
    await handle.chmod(SERVICE_FILE_MODE);
    await handle.writeFile(content, "utf8");
    await handle.close();
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export type ServiceFilePermissionFix = {
  path: string;
  previousMode: number;
};

/**
 * Restricts an existing service file written by an older install to owner-only access.
 * Returns null when there is nothing to change (missing, symlink, not a file, already private).
 */
export async function restrictServiceFilePermissions(
  filePath: string,
): Promise<ServiceFilePermissionFix | null> {
  if (process.platform === "win32") {
    return null;
  }
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") {
      return null;
    }
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) === 0) {
      return null;
    }
    await handle.chmod(SERVICE_FILE_MODE);
    return { path: filePath, previousMode: stat.mode & 0o777 };
  } finally {
    await handle.close();
  }
}
