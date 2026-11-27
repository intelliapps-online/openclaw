import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clearConfigCache } from "../config/config.js";
import type { GatewayClient } from "../gateway/client.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import { handleInvoke, type NodeInvokeRequestPayload } from "./invoke.js";

const MARKER_PREFIX = "PLACEHOLDER_NOT_A_SECRET_";

type InvokeCapture = {
  ok: boolean;
  payloadJSON?: string;
  error?: { code?: string; message?: string };
};

type RunOutput = {
  ok: boolean;
  success: boolean;
  stdout: string;
  stderr: string;
  error: string;
  output: string;
};

type Harness = {
  home: string;
  cwd: string;
  secretPath: string;
  marker: string;
  run: (command: string, env?: Record<string, string>) => Promise<RunOutput>;
};

/**
 * Headless node host with security=allowlist and ask=off (also exercised with
 * ask=on-miss). Safe bins are the default stdin-only list. The command arrives
 * the same way the gateway forwards host=node exec: /bin/sh -lc <raw command>.
 */
async function withNodeHost(params: {
  ask: "off" | "on-miss";
  allowlist?: string[];
  run: (harness: Harness) => Promise<void>;
}): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-safe-bin-"));
  const stateHome = path.join(root, "state");
  const secretHome = path.join(root, "secret-home");
  const cwd = path.join(root, "cwd");
  const configDir = path.join(stateHome, ".openclaw");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(secretHome, ".ssh"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  const marker = `${MARKER_PREFIX}${process.pid}_${Date.now()}`;
  const secretPath = path.join(secretHome, ".ssh", "id_rsa");
  fs.writeFileSync(secretPath, `${marker}\n`, { encoding: "utf8", mode: 0o600 });

  const configPath = path.join(configDir, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        tools: {
          exec: {
            security: "allowlist",
            ask: params.ask,
          },
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(configDir, "exec-approvals.json"),
    JSON.stringify(
      {
        version: 1,
        defaults: {
          security: "allowlist",
          ask: params.ask,
          askFallback: "deny",
        },
        agents: {
          main: {
            allowlist: (params.allowlist ?? []).map((pattern) => ({ pattern })),
          },
        },
      },
      null,
      2,
    ),
  );

  const previous = {
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_DISABLE_CONFIG_CACHE: process.env.OPENCLAW_DISABLE_CONFIG_CACHE,
    HOME: process.env.HOME,
  };
  process.env.OPENCLAW_HOME = stateHome;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_DISABLE_CONFIG_CACHE = "1";
  process.env.HOME = secretHome;
  clearConfigCache();

  try {
    const run = async (command: string, env?: Record<string, string>) => {
      const argv = buildNodeShellCommand(command, "linux");
      expect(argv).toEqual(["/bin/sh", "-lc", command]);
      const results: InvokeCapture[] = [];
      const client = {
        request: async (method: string, requestParams: unknown) => {
          if (
            method === "node.invoke.result" &&
            requestParams &&
            typeof requestParams === "object"
          ) {
            results.push(requestParams as InvokeCapture);
          }
          return { ok: true };
        },
      } as unknown as GatewayClient;
      const frame: NodeInvokeRequestPayload = {
        id: "invoke-safe-bin",
        nodeId: "node-safe-bin",
        command: "system.run",
        paramsJSON: JSON.stringify({
          command: argv,
          rawCommand: command,
          cwd,
          env,
          agentId: "main",
          approved: false,
        }),
      };
      const secretBefore = snapshotTree(secretHome);
      const cwdBefore = snapshotTree(cwd);
      const secretBytes = fs.readFileSync(secretPath);
      await handleInvoke(frame, client, { current: async () => new Set<string>() });
      const captured = results.find((entry) => entry.ok || !entry.ok);
      expect(captured).toBeDefined();
      const parsed = parseRunOutput(captured as InvokeCapture);
      expect(fs.readFileSync(secretPath)).toEqual(secretBytes);
      expect(snapshotTree(secretHome)).toEqual(secretBefore);
      expect(snapshotTree(cwd)).toEqual(cwdBefore);
      return parsed;
    };
    await params.run({ home: secretHome, cwd, secretPath, marker, run });
  } finally {
    restoreEnv(previous);
    clearConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function parseRunOutput(captured: InvokeCapture): RunOutput {
  let stdout = "";
  let stderr = "";
  let success = false;
  let error = captured.error?.message ?? "";
  if (captured.payloadJSON) {
    const payload = JSON.parse(captured.payloadJSON) as {
      stdout?: string;
      stderr?: string;
      success?: boolean;
      error?: string | null;
    };
    stdout = payload.stdout ?? "";
    stderr = payload.stderr ?? "";
    success = payload.success === true;
    if (payload.error) {
      error = payload.error;
    }
  }
  return {
    ok: captured.ok,
    success,
    stdout,
    stderr,
    error,
    output: [stdout, stderr, error].filter(Boolean).join("\n"),
  };
}

function snapshotTree(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      files.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return files.toSorted();
}

function restoreEnv(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function expectNoFileRead(result: RunOutput, harness: Harness) {
  expect(result.output).not.toContain(harness.marker);
  expect(result.output).not.toContain(harness.secretPath);
}

describe("node host safe-bin shell execution", () => {
  it("still runs a stdin-only safe bin when allowlist is empty and ask=off", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withNodeHost({
      ask: "off",
      run: async ({ run }) => {
        const result = await run("head -c 0");
        expect(result.ok).toBe(true);
        expect(result.success).toBe(true);
      },
    });
  });

  it("rejects a safe bin whose argument is an existing file path", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withNodeHost({
      ask: "off",
      run: async (harness) => {
        const relative = path.join(harness.cwd, "local-file");
        fs.writeFileSync(relative, `${harness.marker}\n`, "utf8");
        const absolute = await harness.run(`head -c 4000 ${harness.secretPath}`);
        expect(absolute.ok).toBe(false);
        expectNoFileRead(absolute, harness);
        const byName = await harness.run("head -c 4000 local-file");
        expect(byName.ok).toBe(false);
        expectNoFileRead(byName, harness);
      },
    });
  });

  it.each([
    ["head", (token: string) => `head -c 4000 ${token}`],
    ["tail", (token: string) => `tail -c 4000 ${token}`],
    // `.` is an existing directory, so the safe-bin check rejects it before the shell runs.
    ["grep", (token: string) => `grep -h -F -e ${MARKER_PREFIX.slice(0, -1)} ${token}`],
    ["cut", (token: string) => `cut -c 1- ${token}`],
    ["sort", (token: string) => `sort ${token}`],
    ["uniq", (token: string) => `uniq ${token}`],
    // Same `.` rejection as grep; `tostring` still prints each raw input line.
    ["jq", (token: string) => `jq -Rr tostring ${token}`],
    ["wc", (token: string) => `wc -c ${token}`],
  ])(
    "does not let %s read a file through an unquoted $HOME argument when ask=off",
    async (_bin, buildCommand) => {
      if (process.platform === "win32") {
        return;
      }
      await withNodeHost({
        ask: "off",
        run: async (harness) => {
          const result = await harness.run(buildCommand("$HOME/.ssh/id_rsa"));
          expectNoFileRead(result, harness);
        },
      });
    },
  );

  it("does not let head read a file through $HOME when ask=on-miss and the node is not pre-approved", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withNodeHost({
      ask: "on-miss",
      run: async (harness) => {
        const result = await harness.run("head -c 4000 $HOME/.ssh/id_rsa");
        expectNoFileRead(result, harness);
      },
    });
  });

  it("does not let head read a file through a double-quoted $HOME argument", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withNodeHost({
      ask: "off",
      run: async (harness) => {
        const result = await harness.run('head -c 4000 "$HOME/.ssh/id_rsa"');
        expectNoFileRead(result, harness);
      },
    });
  });

  it("does not let head read a file through a ${HOME} argument", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withNodeHost({
      ask: "off",
      run: async (harness) => {
        const result = await harness.run("head -c 4000 ${HOME}/.ssh/id_rsa");
        expectNoFileRead(result, harness);
      },
    });
  });

  it("does not let head read a file through a request env var", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withNodeHost({
      ask: "off",
      run: async (harness) => {
        const result = await harness.run("head -c 4000 $SECRET_FILE", {
          SECRET_FILE: harness.secretPath,
        });
        expectNoFileRead(result, harness);
      },
    });
  });

  it("does not let a chain of safe bins read a file through $HOME", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withNodeHost({
      ask: "off",
      run: async (harness) => {
        const result = await harness.run(
          "head -c 4000 $HOME/.ssh/id_rsa && tail -n 1 $HOME/.ssh/id_rsa",
        );
        expectNoFileRead(result, harness);
      },
    });
  });

  it("does not let a safe-bin segment read a file when an earlier segment is allowlisted", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withNodeHost({
      ask: "off",
      allowlist: ["/bin/echo", "/usr/bin/echo"],
      run: async (harness) => {
        const result = await harness.run("echo ok && head -c 4000 $HOME/.ssh/id_rsa");
        expectNoFileRead(result, harness);
      },
    });
  });

  it("does not let a pipeline of safe bins read a file through $HOME", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withNodeHost({
      ask: "off",
      run: async (harness) => {
        const result = await harness.run("head -c 4000 $HOME/.ssh/id_rsa | tail -n 1");
        expectNoFileRead(result, harness);
      },
    });
  });
});
