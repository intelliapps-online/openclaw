import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExecTool } from "../agents/bash-tools.exec.js";
import { getShellConfig } from "../agents/shell-utils.js";
import { parseEnvPairs } from "../cli/nodes-run.js";
import { clearConfigCache } from "../config/config.js";
import type { GatewayClient as NodeHostClient } from "../gateway/client.js";
import { ExecApprovalManager } from "../gateway/exec-approval-manager.js";
import { sanitizeSystemRunParamsForForwarding } from "../gateway/node-invoke-system-run-approval.js";
import type { GatewayClient } from "../gateway/server-methods/types.js";
import {
  resolveCommandResolution,
  saveExecApprovals,
  type ExecAllowlistEntry,
  type ExecApprovalsFile,
} from "../infra/exec-approvals.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import { handleInvoke, type SkillBinsProvider } from "./invoke.js";

/**
 * Spec for the node-host system.run env approval bypass.
 *
 * These tests fail while caller env can make an allowlisted or previously
 * approved command execute a different program. They pass once that execution
 * no longer happens.
 *
 * Not executed here:
 * - macOS companion exec host (invoke.ts takes that branch only on darwin and
 *   forwards the original env to a companion app this host does not run)
 * - Windows cmd.exe wrapper (this suite runs the POSIX git and /bin/sh paths)
 */

const skillBins: SkillBinsProvider = {
  async current() {
    return new Set<string>();
  },
};

// operator.write may call node.invoke. It must not carry operator.admin or
// operator.approvals; those scopes are what the gateway treats as approval-capable.
const operatorWriteClient = {
  connId: "operator-write",
  connect: {
    role: "operator",
    scopes: ["operator.write"],
  },
} as GatewayClient;

type InvokeResultBody = {
  ok: boolean;
  payloadJSON?: string;
  error?: { message?: string };
};

type SystemRunPayload = {
  success?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string | null;
};

function resolveAllowlistPattern(bin: string): string {
  // Use the path the allowlist matcher sees. realpath would miss a symlink
  // that resolveExecutablePath returns as-is.
  const resolved = resolveCommandResolution(bin, undefined, process.env)?.resolvedPath;
  if (!resolved) {
    throw new Error(`${bin} is not on PATH; the allowlisted-command cases cannot run`);
  }
  return resolved;
}

function fsmonitorEnv(marker: string): Record<string, string> {
  // git 2.43 runs core.fsmonitor through the shell when the value contains
  // shell metacharacters (a space is enough). The value is the attack command.
  return parseEnvPairs([
    "GIT_CONFIG_COUNT=1",
    "GIT_CONFIG_KEY_0=core.fsmonitor",
    `GIT_CONFIG_VALUE_0=touch ${marker}`,
  ]) as Record<string, string>;
}

function writeApprovals(patterns: string[]) {
  const allowlist: ExecAllowlistEntry[] = patterns.map((pattern) => ({ pattern }));
  const file: ExecApprovalsFile = {
    version: 1,
    defaults: {
      security: "allowlist",
      ask: "on-miss",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    agents: {
      "*": { allowlist },
      main: { allowlist },
    },
  };
  saveExecApprovals(file);
}

function initRepo(root: string): string {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README"), "fixture\n");
  return repo;
}

async function withIsolatedApprovals(run: (home: string) => Promise<void>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-env-"));
  const previous = {
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
  };
  process.env.OPENCLAW_HOME = home;
  process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
  process.env.OPENCLAW_CONFIG_PATH = path.join(home, ".openclaw", "missing.json");
  clearConfigCache();
  try {
    await run(home);
  } finally {
    if (previous.OPENCLAW_HOME === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previous.OPENCLAW_HOME;
    }
    if (previous.OPENCLAW_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous.OPENCLAW_STATE_DIR;
    }
    if (previous.OPENCLAW_CONFIG_PATH === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previous.OPENCLAW_CONFIG_PATH;
    }
    clearConfigCache();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("system.run params were not an object");
  }
  return value as Record<string, unknown>;
}

async function runForwardedSystemRun(params: {
  rawParams: Record<string, unknown>;
  manager?: ExecApprovalManager;
}): Promise<{ denied: string | null; payload: SystemRunPayload | null }> {
  const forwarded = sanitizeSystemRunParamsForForwarding({
    rawParams: params.rawParams,
    client: operatorWriteClient,
    execApprovalManager: params.manager,
  });
  if (!forwarded.ok) {
    return { denied: forwarded.message, payload: null };
  }
  // Same JSON hop the gateway uses before the node host parses paramsJSON.
  const paramsJSON = JSON.stringify(asRecord(forwarded.params));
  const results: InvokeResultBody[] = [];
  const client = {
    request: async (method: string, body: unknown) => {
      if (method === "node.invoke.result") {
        results.push(body as InvokeResultBody);
      }
      return {};
    },
  } as unknown as NodeHostClient;
  await handleInvoke(
    {
      id: "invoke-env",
      nodeId: "node-env",
      command: "system.run",
      paramsJSON,
    },
    client,
    skillBins,
  );
  const body = results.at(-1);
  if (!body) {
    return { denied: "node host returned no invoke result", payload: null };
  }
  if (!body.ok) {
    return { denied: body.error?.message ?? "system.run denied", payload: null };
  }
  const payload = body.payloadJSON ? (JSON.parse(body.payloadJSON) as SystemRunPayload) : null;
  return { denied: null, payload };
}

describe("system.run caller env cannot bypass exec approvals", () => {
  it.skipIf(process.platform === "win32")(
    "runs an allowlisted git status, and does not run core.fsmonitor from caller env",
    async () => {
      const gitPattern = resolveAllowlistPattern("git");
      await withIsolatedApprovals(async (home) => {
        writeApprovals([gitPattern]);
        const repo = initRepo(home);
        const benignMarker = path.join(home, "benign-marker");
        const attackMarker = path.join(home, "attack-marker");

        const benign = await runForwardedSystemRun({
          rawParams: {
            command: ["git", "status", "--porcelain"],
            cwd: repo,
          },
        });
        expect(benign.denied, JSON.stringify(benign)).toBeNull();
        expect(benign.payload?.success, JSON.stringify(benign.payload)).toBe(true);
        expect(fs.existsSync(benignMarker)).toBe(false);

        const attack = await runForwardedSystemRun({
          rawParams: {
            command: ["git", "status", "--porcelain"],
            cwd: repo,
            env: fsmonitorEnv(attackMarker),
          },
        });
        expect(fs.existsSync(attackMarker), JSON.stringify(attack)).toBe(false);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "runs allowlisted git status via the node shell wrapper without executing caller fsmonitor env",
    async () => {
      const gitPattern = resolveAllowlistPattern("git");
      await withIsolatedApprovals(async (home) => {
        writeApprovals([gitPattern]);
        const repo = initRepo(home);
        const marker = path.join(home, "shell-wrapper-marker");
        const argv = buildNodeShellCommand("git status --porcelain", "linux");
        const benign = await runForwardedSystemRun({
          rawParams: {
            command: argv,
            rawCommand: "git status --porcelain",
            cwd: repo,
          },
        });
        expect(benign.denied, JSON.stringify(benign)).toBeNull();
        expect(benign.payload?.success, JSON.stringify(benign.payload)).toBe(true);

        const attack = await runForwardedSystemRun({
          rawParams: {
            command: argv,
            rawCommand: "git status --porcelain",
            cwd: repo,
            env: fsmonitorEnv(marker),
          },
        });
        expect(fs.existsSync(marker), JSON.stringify(attack)).toBe(false);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not treat an approval for git status as approval of a different env",
    async () => {
      await withIsolatedApprovals(async (home) => {
        writeApprovals([]);
        const repo = initRepo(home);
        const manager = new ExecApprovalManager();
        const runId = "approval-git-status";
        const record = manager.create(
          {
            command: "git status --porcelain",
            cwd: repo,
            host: "node",
          },
          60_000,
          runId,
        );
        void manager.register(record, 60_000);
        const resolved = manager.resolve(runId, "allow-once", "approver");
        expect(resolved).toBe(true);

        const denied = await runForwardedSystemRun({
          rawParams: {
            command: ["git", "status", "--porcelain"],
            cwd: repo,
            env: fsmonitorEnv(path.join(home, "unapproved-marker")),
          },
          manager,
        });
        expect(denied.denied, JSON.stringify(denied)).toBeTruthy();
        expect(fs.existsSync(path.join(home, "unapproved-marker"))).toBe(false);

        const approved = await runForwardedSystemRun({
          rawParams: {
            command: ["git", "status", "--porcelain"],
            cwd: repo,
            approved: true,
            approvalDecision: "allow-once",
            runId,
          },
          manager,
        });
        expect(approved.denied, JSON.stringify(approved)).toBeNull();
        expect(approved.payload?.success, JSON.stringify(approved.payload)).toBe(true);

        const marker = path.join(home, "approved-env-marker");
        const rebound = await runForwardedSystemRun({
          rawParams: {
            command: ["git", "status", "--porcelain"],
            cwd: repo,
            env: fsmonitorEnv(marker),
            approved: true,
            approvalDecision: "allow-once",
            runId,
          },
          manager,
        });
        expect(fs.existsSync(marker), JSON.stringify(rebound)).toBe(false);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "gateway exec allowlist does not run core.fsmonitor from caller env",
    async () => {
      const gitPattern = resolveAllowlistPattern("git");
      await withIsolatedApprovals(async (home) => {
        writeApprovals([gitPattern]);
        const repo = initRepo(home);
        const tool = createExecTool({
          host: "gateway",
          security: "allowlist",
          ask: "on-miss",
          allowBackground: false,
          notifyOnExit: false,
          timeoutSec: 20,
        });

        const benign = await tool.execute("benign", {
          command: "git status --porcelain",
          workdir: repo,
          timeout: 20,
        });
        expect(benign.details.status).toBe("completed");

        const gitMarker = path.join(home, "gateway-git-marker");
        try {
          await tool.execute("git-env", {
            command: "git status --porcelain",
            workdir: repo,
            timeout: 20,
            env: fsmonitorEnv(gitMarker),
          });
        } catch {
          // Refusing the env before the command runs is a valid fix.
        }
        expect(fs.existsSync(gitMarker)).toBe(false);
      });
    },
  );

  it.skipIf(process.platform === "win32" || path.basename(getShellConfig().shell) !== "bash")(
    "gateway exec allowlist does not run an imported bash function in place of the command",
    async () => {
      const truePattern = resolveAllowlistPattern("true");
      await withIsolatedApprovals(async (home) => {
        writeApprovals([truePattern]);
        const tool = createExecTool({
          host: "gateway",
          security: "allowlist",
          ask: "on-miss",
          allowBackground: false,
          notifyOnExit: false,
          timeoutSec: 20,
        });
        const benign = await tool.execute("benign-true", {
          command: "true",
          workdir: home,
          timeout: 20,
        });
        expect(benign.details.status).toBe("completed");

        const bashMarker = path.join(home, "gateway-bash-marker");
        try {
          await tool.execute("bash-func", {
            command: "true",
            workdir: home,
            timeout: 20,
            env: {
              "BASH_FUNC_true%%": `() { echo ran > ${bashMarker}; }`,
            },
          });
        } catch {
          // Refusing the env before the command runs is a valid fix.
        }
        expect(fs.existsSync(bashMarker)).toBe(false);
      });
    },
  );
});
