/**
 * Safe-bin options must not bypass the exec allowlist.
 *
 * These tests exercise the gateway exec tool and the node host system.run
 * handler with the default safe bins. They fail while dangerous options of
 * those bins are treated as safe and executed without an approval prompt.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../config/config.js";
import type { GatewayClient } from "../gateway/client.js";

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return {
    ...mod,
    // Keep resolution on the test process PATH. The login-shell lookup is
    // unrelated to option checking and can hang in CI.
    getShellPathFromLoginShell: vi.fn(() => null),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 50),
  };
});

vi.mock("./tools/gateway.js", () => ({
  // Approval requests must not hang, and must not approve the command.
  callGatewayTool: vi.fn(async () => {
    throw new Error("approval gateway unavailable");
  }),
}));

type ExecOutcome = {
  text: string;
  status?: string;
};

type NodeRequest = {
  method: string;
  params: { ok?: boolean; payloadJSON?: string | null; error?: { message?: string } };
};

type NodeOutcome = {
  ok?: boolean;
  stdout: string;
  stderr: string;
};

const SPILL_LINES = 6000;

function assertGnuUserland(): void {
  const sortVersion = execFileSync("sort", ["--version"], { encoding: "utf8" });
  const grepVersion = execFileSync("grep", ["--version"], { encoding: "utf8" });
  const jqVersion = execFileSync("jq", ["--version"], { encoding: "utf8" });
  expect(sortVersion).toContain("GNU coreutils");
  expect(grepVersion).toContain("GNU grep");
  expect(jqVersion.startsWith("jq-")).toBe(true);
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-safe-bin-opts-"));
}

function writeFile(dir: string, name: string, contents: string): string {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function spillCommand(scriptLine: string, sortArgs: string): string {
  return `jq -nr 'range(${SPILL_LINES})|"${scriptLine}"' | sort -S1 ${sortArgs}`;
}

async function runGateway(workdir: string, command: string): Promise<ExecOutcome> {
  const { createExecTool } = await import("./bash-tools.exec.js");
  const tool = createExecTool({
    host: "gateway",
    cwd: workdir,
    backgroundMs: 30_000,
    timeoutSec: 20,
    notifyOnExit: false,
    approvalRunningNoticeMs: 0,
  });
  try {
    const result = await tool.execute("safe-bin-options", {
      command,
      workdir,
      timeout: 20,
    });
    const text = result.content.map((content) => content.text ?? "").join("\n");
    const status =
      result.details && typeof result.details.status === "string"
        ? result.details.status
        : undefined;
    return { text, status };
  } catch {
    return { text: "" };
  }
}

function expectNotExecuted(outcome: ExecOutcome): void {
  expect(outcome.status).not.toBe("completed");
  expect(outcome.status).not.toBe("running");
  expect(outcome.status).not.toBe("failed");
}

async function runNode(workdir: string, command: string, argv?: string[]): Promise<NodeOutcome> {
  const { handleInvoke } = await import("../node-host/invoke.js");
  clearConfigCache();
  const requests: NodeRequest[] = [];
  const client = {
    request: async (method: string, params: NodeRequest["params"]) => {
      requests.push({ method, params });
      return { ok: true };
    },
  } as unknown as GatewayClient;
  const commandArgv = argv ?? ["/bin/sh", "-lc", command];
  await handleInvoke(
    {
      id: "safe-bin-options",
      nodeId: "node-1",
      command: "system.run",
      paramsJSON: JSON.stringify({
        command: commandArgv,
        rawCommand: argv ? null : command,
        cwd: workdir,
        agentId: "main",
        approved: false,
      }),
    },
    client,
    { current: async () => new Set<string>() },
  );
  const result = requests.find((request) => request.method === "node.invoke.result");
  let stdout = "";
  let stderr = "";
  if (typeof result?.params.payloadJSON === "string") {
    const payload = JSON.parse(result.params.payloadJSON) as {
      stdout?: string;
      stderr?: string;
    };
    stdout = payload.stdout ?? "";
    stderr = payload.stderr ?? "";
  }
  return { ok: result?.params.ok, stdout, stderr };
}

function expectNodeDidNotRun(outcome: NodeOutcome): void {
  expect(outcome.ok).not.toBe(true);
}

describe.skipIf(process.platform !== "linux")(
  "safe bin options cannot bypass exec approval",
  () => {
    let previousHome: string | undefined;
    let previousState: string | undefined;
    let previousConfig: string | undefined;

    beforeAll(() => {
      assertGnuUserland();
    });

    beforeEach(() => {
      previousHome = process.env.OPENCLAW_HOME;
      previousState = process.env.OPENCLAW_STATE_DIR;
      previousConfig = process.env.OPENCLAW_CONFIG_PATH;
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-home-"));
      process.env.OPENCLAW_HOME = home;
      process.env.OPENCLAW_STATE_DIR = path.join(home, "state");
      delete process.env.OPENCLAW_CONFIG_PATH;
      clearConfigCache();
    });

    afterEach(() => {
      if (previousHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousHome;
      }
      if (previousState === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousState;
      }
      if (previousConfig === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfig;
      }
      clearConfigCache();
    });

    it("does not run sort --compress-program through the gateway exec tool", async () => {
      const workdir = makeWorkspace();
      const marker = path.join(workdir, "marker-compress");
      const outcome = await runGateway(
        workdir,
        spillCommand("touch marker-compress", "--compress-program=sh"),
      );
      expect(fs.existsSync(marker)).toBe(false);
      expectNotExecuted(outcome);
    });

    it("does not run sort --compress-program as a separate argument", async () => {
      const workdir = makeWorkspace();
      const marker = path.join(workdir, "marker-compress-sep");
      const outcome = await runGateway(
        workdir,
        spillCommand("touch marker-compress-sep", "--compress-program sh"),
      );
      expect(fs.existsSync(marker)).toBe(false);
      expectNotExecuted(outcome);
    });

    it("does not let sort -o overwrite an existing file", async () => {
      const workdir = makeWorkspace();
      const target = writeFile(workdir, "startup-file", "original\n");
      const outcome = await runGateway(workdir, "sort -ostartup-file");
      expect(fs.readFileSync(target, "utf8")).toBe("original\n");
      expectNotExecuted(outcome);
    });

    it("does not let sort --output create a new file", async () => {
      const workdir = makeWorkspace();
      const target = path.join(workdir, "created-by-sort");
      const outcome = await runGateway(workdir, "sort --output=created-by-sort");
      expect(fs.existsSync(target)).toBe(false);
      expectNotExecuted(outcome);
    });

    it("does not let grep -f read an existing pattern file", async () => {
      const workdir = makeWorkspace();
      writeFile(workdir, "patterns", "from-file\n");
      const outcome = await runGateway(
        workdir,
        `jq -nr '"prefix-from-file-suffix"' | grep -fpatterns`,
      );
      expect(outcome.text).not.toContain("prefix-from-file-suffix");
      expectNotExecuted(outcome);
    });

    it("does not let grep -r read the working directory", async () => {
      const workdir = makeWorkspace();
      writeFile(workdir, "nested-secret.txt", "only-on-disk-secret\n");
      const outcome = await runGateway(workdir, "grep -r only-on-disk");
      expect(outcome.text).not.toContain("nested-secret.txt");
      expectNotExecuted(outcome);
    });

    it("does not let grep -R read the working directory", async () => {
      const workdir = makeWorkspace();
      writeFile(workdir, "nested-secret.txt", "only-on-disk-secret\n");
      const outcome = await runGateway(workdir, "grep -R only-on-disk");
      expect(outcome.text).not.toContain("nested-secret.txt");
      expectNotExecuted(outcome);
    });

    it("does not let grep -d recurse read the working directory", async () => {
      const workdir = makeWorkspace();
      writeFile(workdir, "nested-secret.txt", "only-on-disk-secret\n");
      const outcome = await runGateway(workdir, "grep -d recurse only-on-disk");
      expect(outcome.text).not.toContain("nested-secret.txt");
      expectNotExecuted(outcome);
    });

    it("does not let jq -L load a module directory", async () => {
      const workdir = makeWorkspace();
      writeFile(workdir, "mods/pwn.jq", 'def pwn: "JQ_LIB_SECRET_77";\n');
      const outcome = await runGateway(workdir, `jq -n -Lmods 'include "pwn"; pwn'`);
      expect(outcome.text).not.toContain("JQ_LIB_SECRET_77");
      expectNotExecuted(outcome);
    });

    it("does not let sort -T write temporaries into a chosen directory", async () => {
      const workdir = makeWorkspace();
      const sink = path.join(workdir, "sink");
      fs.mkdirSync(sink);
      const seen: string[] = [];
      const watcher = fs.watch(sink, (_event, filename) => {
        seen.push(filename ?? "");
      });
      const outcome = await runGateway(workdir, spillCommand("line", "-Tsink"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      watcher.close();
      expect(seen).toEqual([]);
      expect(fs.readdirSync(sink)).toEqual([]);
      expectNotExecuted(outcome);
    });

    it("does not run the compress-program pipeline on the node host", async () => {
      const workdir = makeWorkspace();
      const marker = path.join(workdir, "marker-compress");
      const command = spillCommand("touch marker-compress", "--compress-program=sh");
      const outcome = await runNode(workdir, command);
      expect(fs.existsSync(marker)).toBe(false);
      expectNodeDidNotRun(outcome);
    });

    it("does not run a separate compress-program argument on the node host", async () => {
      const workdir = makeWorkspace();
      const marker = path.join(workdir, "marker-compress-sep");
      const command = spillCommand("touch marker-compress-sep", "--compress-program sh");
      const outcome = await runNode(workdir, command);
      expect(fs.existsSync(marker)).toBe(false);
      expectNodeDidNotRun(outcome);
    });

    it("does not let node system.run sort -o overwrite a file", async () => {
      const workdir = makeWorkspace();
      const target = writeFile(workdir, "startup-file", "original\n");
      const outcome = await runNode(workdir, "sort -ostartup-file", ["sort", "-ostartup-file"]);
      expect(fs.readFileSync(target, "utf8")).toBe("original\n");
      expectNodeDidNotRun(outcome);
    });

    it("does not let node system.run sort --output create a file", async () => {
      const workdir = makeWorkspace();
      const target = path.join(workdir, "created-by-sort");
      const outcome = await runNode(workdir, "sort --output=created-by-sort", [
        "sort",
        "--output=created-by-sort",
      ]);
      expect(fs.existsSync(target)).toBe(false);
      expectNodeDidNotRun(outcome);
    });

    it("does not let node system.run grep -f disclose a pattern file", async () => {
      const workdir = makeWorkspace();
      writeFile(workdir, "patterns", "from-file\n");
      const command = `jq -nr '"prefix-from-file-suffix"' | grep -fpatterns`;
      const outcome = await runNode(workdir, command);
      expect(`${outcome.stdout}\n${outcome.stderr}`).not.toContain("prefix-from-file-suffix");
      expectNodeDidNotRun(outcome);
    });

    it("does not let node system.run grep -r read the working directory", async () => {
      const workdir = makeWorkspace();
      writeFile(workdir, "nested-secret.txt", "only-on-disk-secret\n");
      const outcome = await runNode(workdir, "grep -r only-on-disk", [
        "grep",
        "-r",
        "only-on-disk",
      ]);
      expect(`${outcome.stdout}\n${outcome.stderr}`).not.toContain("nested-secret.txt");
      expectNodeDidNotRun(outcome);
    });

    it("does not let node system.run grep -R read the working directory", async () => {
      const workdir = makeWorkspace();
      writeFile(workdir, "nested-secret.txt", "only-on-disk-secret\n");
      const outcome = await runNode(workdir, "grep -R only-on-disk", [
        "grep",
        "-R",
        "only-on-disk",
      ]);
      expect(`${outcome.stdout}\n${outcome.stderr}`).not.toContain("nested-secret.txt");
      expectNodeDidNotRun(outcome);
    });

    it("does not let node system.run grep -d recurse read the working directory", async () => {
      const workdir = makeWorkspace();
      writeFile(workdir, "nested-secret.txt", "only-on-disk-secret\n");
      const outcome = await runNode(workdir, "grep -d recurse only-on-disk", [
        "grep",
        "-d",
        "recurse",
        "only-on-disk",
      ]);
      expect(`${outcome.stdout}\n${outcome.stderr}`).not.toContain("nested-secret.txt");
      expectNodeDidNotRun(outcome);
    });

    it("does not let node system.run jq -L load a module", async () => {
      const workdir = makeWorkspace();
      writeFile(workdir, "mods/pwn.jq", 'def pwn: "JQ_LIB_SECRET_77";\n');
      const outcome = await runNode(workdir, `jq -n -Lmods 'include "pwn"; pwn'`, [
        "jq",
        "-n",
        "-Lmods",
        'include "pwn"; pwn',
      ]);
      expect(`${outcome.stdout}\n${outcome.stderr}`).not.toContain("JQ_LIB_SECRET_77");
      expectNodeDidNotRun(outcome);
    });

    it("does not let node system.run sort -T write into a chosen directory", async () => {
      const workdir = makeWorkspace();
      const sink = path.join(workdir, "sink");
      fs.mkdirSync(sink);
      const seen: string[] = [];
      const watcher = fs.watch(sink, (_event, filename) => {
        seen.push(filename ?? "");
      });
      const command = spillCommand("line", "-Tsink");
      const outcome = await runNode(workdir, command);
      await new Promise((resolve) => setTimeout(resolve, 50));
      watcher.close();
      expect(seen).toEqual([]);
      expect(fs.readdirSync(sink)).toEqual([]);
      expectNodeDidNotRun(outcome);
    });
  },
);
