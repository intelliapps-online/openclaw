import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigCache } from "../config/config.js";
import type { GatewayClient } from "../gateway/client.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import { handleInvoke, type NodeInvokeRequestPayload } from "./invoke.js";

const savedEnv = new Map<string, string | undefined>();

function rememberEnv(name: string) {
  if (!savedEnv.has(name)) {
    savedEnv.set(name, process.env[name]);
  }
}

function restoreEnv() {
  for (const [name, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  savedEnv.clear();
}

function bashFunction(body: string): string {
  return `() {  ${body}\n}\n`;
}

function writeAllowlist(home: string, patterns: string[]) {
  const dir = path.join(home, ".openclaw");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "openclaw.json"), "{}\n");
  fs.writeFileSync(
    path.join(dir, "exec-approvals.json"),
    `${JSON.stringify(
      {
        version: 1,
        defaults: {
          security: "allowlist",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: false,
        },
        agents: {
          main: {
            security: "allowlist",
            ask: "on-miss",
            askFallback: "deny",
            autoAllowSkills: false,
            allowlist: patterns.map((pattern) => ({ pattern })),
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function gitInit(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const result = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || "git init failed");
  }
}

describe("node host system.run environment boundary", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-env-"));
    for (const name of [
      "HOME",
      "OPENCLAW_HOME",
      "USERPROFILE",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_STATE_DIR",
    ]) {
      rememberEnv(name);
    }
    process.env.HOME = home;
    process.env.OPENCLAW_HOME = home;
    process.env.USERPROFILE = home;
    process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
    process.env.OPENCLAW_CONFIG_PATH = path.join(home, ".openclaw", "openclaw.json");
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function invoke(params: Record<string, unknown>) {
    const frame: NodeInvokeRequestPayload = {
      id: "invoke-1",
      nodeId: "node-1",
      command: "system.run",
      paramsJSON: JSON.stringify(params),
    };
    const sent: Array<{ ok?: boolean; payloadJSON?: string; error?: { message?: string } }> = [];
    const client = {
      request: async (
        _method: string,
        payload: { ok?: boolean; payloadJSON?: string; error?: { message?: string } },
      ) => {
        sent.push(payload);
      },
    };
    await handleInvoke(frame, client as unknown as GatewayClient, {
      current: async () => new Set<string>(),
    });
    return sent.at(-1);
  }

  function assertPayloadDidNotRun(marker: string, token: string, detail: string) {
    const written = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
    expect(written, detail).not.toContain(token);
    expect(fs.existsSync(marker), detail).toBe(false);
  }

  it("does not apply git config environment keys when the gateway shell wrapper runs git", async () => {
    const repo = path.join(home, "repo");
    const marker = path.join(home, "git-marker");
    const token = "node-git-config-hijack";
    gitInit(repo);
    writeAllowlist(home, ["/usr/bin/git"]);
    clearConfigCache();
    const command = "git status --porcelain";
    const result = await invoke({
      command: buildNodeShellCommand(command),
      rawCommand: command,
      cwd: repo,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: `/usr/bin/printf ${token} > '${marker}'`,
      },
      agentId: "main",
    });
    assertPayloadDidNotRun(marker, token, JSON.stringify(result));
  });

  it("does not apply git config environment keys to a direct git argv", async () => {
    const repo = path.join(home, "repo-direct");
    const marker = path.join(home, "git-direct-marker");
    const token = "node-git-direct-hijack";
    gitInit(repo);
    writeAllowlist(home, ["/usr/bin/git"]);
    clearConfigCache();
    const result = await invoke({
      command: ["/usr/bin/git", "status", "--porcelain"],
      cwd: repo,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: `/usr/bin/printf ${token} > '${marker}'`,
      },
      agentId: "main",
    });
    assertPayloadDidNotRun(marker, token, JSON.stringify(result));
  });

  it("does not apply GIT_SSH_COMMAND to a direct git argv", async () => {
    const repo = path.join(home, "repo-ssh");
    const marker = path.join(home, "ssh-marker");
    const token = "node-git-ssh-hijack";
    gitInit(repo);
    writeAllowlist(home, ["/usr/bin/git"]);
    clearConfigCache();
    const result = await invoke({
      command: ["/usr/bin/git", "ls-remote", "ssh://127.0.0.1/does-not-exist"],
      cwd: repo,
      env: { GIT_SSH_COMMAND: `/usr/bin/printf ${token} > '${marker}'` },
      agentId: "main",
    });
    assertPayloadDidNotRun(marker, token, JSON.stringify(result));
  });

  it("does not let HOME select a gitconfig that runs code", async () => {
    const repo = path.join(home, "repo-home");
    const fakeHome = path.join(home, "fake-home");
    const marker = path.join(home, "home-marker");
    const token = "node-home-git-hijack";
    gitInit(repo);
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".gitconfig"),
      `[core]\n\tfsmonitor = /usr/bin/printf ${token} > '${marker}'\n`,
    );
    writeAllowlist(home, ["/usr/bin/git"]);
    clearConfigCache();
    const result = await invoke({
      command: ["/usr/bin/git", "status", "--porcelain"],
      cwd: repo,
      env: { HOME: fakeHome },
      agentId: "main",
    });
    assertPayloadDidNotRun(marker, token, JSON.stringify(result));
  });

  it("does not import a bash function when bash is invoked directly", async () => {
    const marker = path.join(home, "bash-marker");
    const token = "node-bash-func-hijack";
    writeAllowlist(home, ["/usr/bin/bash"]);
    clearConfigCache();
    const result = await invoke({
      command: ["/usr/bin/bash", "-c", "wc -l"],
      cwd: home,
      env: { "BASH_FUNC_wc%%": bashFunction(`/usr/bin/printf ${token} > '${marker}'`) },
      agentId: "main",
    });
    assertPayloadDidNotRun(marker, token, JSON.stringify(result));
  });
});
