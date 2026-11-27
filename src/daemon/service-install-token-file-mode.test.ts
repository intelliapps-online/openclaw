import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("./exec-file.js", () => ({
  execFileUtf8: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
}));

import { buildGatewayInstallPlan } from "../commands/daemon-install-helpers.js";
import { installLaunchAgent } from "./launchd.js";
import { installScheduledTask } from "./schtasks.js";
import { resolveGatewayService } from "./service.js";
import { installSystemdService, resolveSystemdUserUnitPath } from "./systemd.js";

const PLACEHOLDER = "placeholder-gateway-token";
const QUOTED_PLACEHOLDER = "placeholder gateway token";

const stdout = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

// These tests are the spec for the gateway-token file written by service install.
// They fail while that token is readable by another local user, and pass once it is not.
describe.skipIf(process.platform === "win32")("gateway token file permissions", () => {
  it("hides the token when systemd install creates the user unit directory", async () => {
    await withInstallHome(async (home) => {
      const env = serviceEnv(home);
      const installed = await installGatewayUnit(env, PLACEHOLDER);
      await expectTokenHiddenFromOtherUsers(home, installed.unitPath, PLACEHOLDER);
    });
  });

  it("hides the token when the systemd user unit directory already exists and is traversable", async () => {
    await withInstallHome(async (home) => {
      const env = serviceEnv(home, "shared");
      const unitPath = resolveSystemdUserUnitPath(env);
      await makeExistingTraversableDir(path.dirname(unitPath), home);
      const installed = await installGatewayUnit(env, PLACEHOLDER);
      await installGatewayUnit(env, PLACEHOLDER);
      expect(installed.unitPath).toBe(unitPath);
      await expectTokenHiddenFromOtherUsers(home, unitPath, PLACEHOLDER);
    });
  });

  it("hides a token that contains spaces when systemd install writes the unit", async () => {
    await withInstallHome(async (home) => {
      const env = serviceEnv(home);
      const installed = await installGatewayUnit(env, QUOTED_PLACEHOLDER);
      await expectTokenHiddenFromOtherUsers(home, installed.unitPath, QUOTED_PLACEHOLDER);
    });
  });

  it("hides the token when LaunchAgent install writes the plist", async () => {
    await withInstallHome(async (home) => {
      const env = serviceEnv(home);
      await makeExistingTraversableDir(path.join(home, "Library", "LaunchAgents"), home);
      const { environment } = await planGatewayInstall(env, PLACEHOLDER);
      const installed = await installLaunchAgent({
        env,
        stdout,
        programArguments: ["openclaw", "gateway"],
        environment,
      });
      await expectTokenHiddenFromOtherUsers(home, installed.plistPath, PLACEHOLDER);
    });
  });

  it("hides the token when scheduled task install writes the task script", async () => {
    await withInstallHome(async (home) => {
      const env = serviceEnv(home);
      await makeExistingTraversableDir(path.join(home, ".openclaw"), home);
      const { environment } = await planGatewayInstall(env, PLACEHOLDER);
      const installed = await installScheduledTask({
        env,
        stdout,
        programArguments: ["openclaw", "gateway"],
        environment,
      });
      await expectTokenHiddenFromOtherUsers(home, installed.scriptPath, PLACEHOLDER);
    });
  });
});

async function withInstallHome(run: (home: string) => Promise<void>): Promise<void> {
  const previous = process.umask(0o022);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-unit-home-"));
  await fs.chmod(home, 0o755);
  try {
    await run(home);
  } finally {
    process.umask(previous);
    await fs.rm(home, { recursive: true, force: true });
  }
}

function serviceEnv(home: string, profile?: string): Record<string, string | undefined> {
  return {
    HOME: home,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    USER: process.env.USER,
    ...(profile ? { OPENCLAW_PROFILE: profile } : {}),
  };
}

async function installGatewayUnit(
  env: Record<string, string | undefined>,
  token: string,
): Promise<{ unitPath: string }> {
  const { programArguments, workingDirectory, environment } = await planGatewayInstall(env, token);
  if (process.platform === "linux") {
    await resolveGatewayService().install({
      env,
      stdout,
      programArguments,
      workingDirectory,
      environment,
    });
    return { unitPath: resolveSystemdUserUnitPath(env) };
  }
  return await installSystemdService({
    env,
    stdout,
    programArguments,
    workingDirectory,
    environment,
  });
}

async function planGatewayInstall(
  env: Record<string, string | undefined>,
  token: string,
): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
}> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-fixture-"));
  await fs.mkdir(path.join(fixtureRoot, "dist"));
  await fs.writeFile(path.join(fixtureRoot, "dist", "index.js"), "// fixture\n");
  const previousArgv = process.argv[1];
  process.argv[1] = path.join(fixtureRoot, "openclaw.mjs");
  try {
    return await buildGatewayInstallPlan({
      env,
      port: 18789,
      token,
      runtime: "node",
      nodePath: process.execPath,
      devMode: false,
      warn: () => {},
    });
  } finally {
    process.argv[1] = previousArgv;
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function makeExistingTraversableDir(dir: string, home: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  let current = dir;
  while (current.startsWith(home)) {
    await fs.chmod(current, 0o755);
    if (current === home) {
      break;
    }
    current = path.dirname(current);
  }
}

async function expectTokenHiddenFromOtherUsers(
  home: string,
  writtenPath: string,
  placeholder: string,
): Promise<void> {
  const written = await fs.readFile(writtenPath, "utf8");
  expect(written.length).toBeGreaterThan(0);
  const leaks = await otherUserReadableFilesContaining(home, placeholder);
  expect(leaks).toEqual([]);
}

async function otherUserReadableFilesContaining(
  root: string,
  placeholder: string,
): Promise<string[]> {
  const leaks: string[] = [];
  for (const file of await listFiles(root)) {
    const text = await fs.readFile(file, "utf8");
    if (!text.includes(placeholder)) {
      continue;
    }
    const modeReadable = otherCanReadByMode(file);
    const other = readAsOtherUser(file);
    if (other.checked) {
      expect(Boolean(other.text?.includes(placeholder))).toBe(modeReadable);
    }
    if (modeReadable) {
      const mode = statSync(file).mode & 0o777;
      leaks.push(`${file} mode ${mode.toString(8)}`);
    }
  }
  return leaks;
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  await walk(root);
  return files;
}

function readAsOtherUser(filePath: string): { checked: boolean; text: string | null } {
  const result = spawnSync("sudo", ["-n", "-u", "nobody", "cat", "--", filePath], {
    encoding: "utf8",
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { checked: false, text: null };
  }
  const detail = result.stderr ?? "";
  if (/password is required|a password is required|not allowed|no tty present/i.test(detail)) {
    return { checked: false, text: null };
  }
  if (result.status === 0) {
    return { checked: true, text: result.stdout };
  }
  return { checked: true, text: null };
}

function otherCanReadByMode(filePath: string): boolean {
  if ((statSync(filePath).mode & 0o004) === 0) {
    return false;
  }
  let current = path.dirname(filePath);
  const root = path.parse(current).root;
  while (true) {
    if ((statSync(current).mode & 0o001) === 0) {
      return false;
    }
    if (current === root) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return true;
    }
    current = parent;
  }
}
