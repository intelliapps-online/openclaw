import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateExecApprovalRequestParams } from "../gateway/protocol/index.js";

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return {
    ...mod,
    getShellPathFromLoginShell: () => null,
  };
});

vi.mock("./tools/gateway.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./tools/gateway.js")>();
  return {
    ...mod,
    callGatewayTool: vi.fn(),
  };
});

type ApprovalDecision = "allow-once" | "allow-always" | "deny";

const gatewayState: {
  decision: ApprovalDecision;
  nodeInvokeError: string | null;
  requests: Array<{ method: string; params: unknown }>;
} = {
  decision: "deny",
  nodeInvokeError: null,
  requests: [],
};

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

describe("gateway host exec environment boundary", () => {
  let home: string;
  let previousCwd: string;

  beforeEach(async () => {
    previousCwd = process.cwd();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-host-env-"));
    for (const name of ["HOME", "OPENCLAW_HOME", "USERPROFILE", "SHELL"]) {
      rememberEnv(name);
    }
    process.env.HOME = home;
    process.env.OPENCLAW_HOME = home;
    process.env.USERPROFILE = home;
    process.env.SHELL = "/bin/bash";
    gatewayState.decision = "deny";
    gatewayState.nodeInvokeError = null;
    gatewayState.requests = [];
    const { callGatewayTool } = await import("./tools/gateway.js");
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      gatewayState.requests.push({ method, params });
      if (method === "exec.approval.request") {
        return { decision: gatewayState.decision };
      }
      if (method === "node.list") {
        return {
          nodes: [
            {
              nodeId: "node-1",
              commands: ["system.run"],
              platform: "linux",
              connected: true,
            },
          ],
        };
      }
      if (method === "node.invoke") {
        if (gatewayState.nodeInvokeError) {
          throw new Error(gatewayState.nodeInvokeError);
        }
      }
      throw new Error(`unexpected gateway method ${method}`);
    });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function execTool() {
    const { createExecTool } = await import("./bash-tools.exec.js");
    return createExecTool({
      host: "gateway",
      security: "allowlist",
      ask: "on-miss",
      agentId: "main",
      allowBackground: false,
      notifyOnExit: false,
      approvalRunningNoticeMs: 0,
      timeoutSec: 20,
    });
  }

  async function run(
    command: string,
    env: Record<string, string>,
    workdir: string,
    ask?: "always" | "on-miss" | "off",
  ) {
    const tool = await execTool();
    try {
      const result = await tool.execute("call", { command, env, workdir, ask });
      const text = result.content
        .map((chunk) => (chunk.type === "text" ? chunk.text : ""))
        .join("\n");
      const status =
        result.details && typeof result.details.status === "string"
          ? result.details.status
          : undefined;
      if (status === "approval-pending") {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return { text, status, error: undefined as string | undefined };
    } catch (err) {
      return {
        text: "",
        status: undefined,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  function assertPayloadDidNotRun(marker: string, token: string, outcome: { text: string }) {
    const written = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
    expect(written, outcome.text).not.toContain(token);
    expect(fs.existsSync(marker), outcome.text).toBe(false);
  }

  it("does not let a bash exported function shadow a default safe bin", async () => {
    const marker = path.join(home, "wc-marker");
    const token = "wc-func-hijack";
    const outcome = await run(
      "wc -l",
      { "BASH_FUNC_wc%%": bashFunction(`/usr/bin/printf ${token} > '${marker}'`) },
      home,
    );
    assertPayloadDidNotRun(marker, token, outcome);
  });

  it("does not apply SHELLOPTS and PS4 to an allowlisted safe bin", async () => {
    const marker = path.join(home, "xtrace-marker");
    const token = "xtrace-hijack";
    const outcome = await run(
      "wc -l",
      {
        SHELLOPTS: "xtrace",
        PS4: `$(/usr/bin/printf ${token} > '${marker}')`,
      },
      home,
    );
    assertPayloadDidNotRun(marker, token, outcome);
  });

  it("does not apply git config environment keys to an allowlisted git command", async () => {
    const repo = path.join(home, "repo");
    const marker = path.join(home, "git-marker");
    const token = "git-config-hijack";
    gitInit(repo);
    writeAllowlist(home, ["/usr/bin/git"]);
    const outcome = await run(
      "git status --porcelain",
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: `/usr/bin/printf ${token} > '${marker}'`,
      },
      repo,
    );
    assertPayloadDidNotRun(marker, token, outcome);
  });

  it("does not let HOME select a gitconfig that runs code for an allowlisted git command", async () => {
    const repo = path.join(home, "repo-home");
    const fakeHome = path.join(home, "fake-home");
    const marker = path.join(home, "home-marker");
    const token = "home-git-hijack";
    gitInit(repo);
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".gitconfig"),
      `[core]\n\tfsmonitor = /usr/bin/printf ${token} > '${marker}'\n`,
    );
    writeAllowlist(home, ["/usr/bin/git"]);
    const outcome = await run("git status --porcelain", { HOME: fakeHome }, repo);
    assertPayloadDidNotRun(marker, token, outcome);
  });

  it("does not apply GIT_SSH_COMMAND to an allowlisted git command", async () => {
    const repo = path.join(home, "repo-ssh");
    const marker = path.join(home, "ssh-marker");
    const token = "git-ssh-hijack";
    gitInit(repo);
    writeAllowlist(home, ["/usr/bin/git"]);
    const outcome = await run(
      "git ls-remote ssh://127.0.0.1/does-not-exist",
      { GIT_SSH_COMMAND: `/usr/bin/printf ${token} > '${marker}'` },
      repo,
    );
    assertPayloadDidNotRun(marker, token, outcome);
  });

  it("does not apply PERL5OPT to an allowlisted perl command", async () => {
    const marker = path.join(home, "perl-marker");
    const token = "perl-opt-hijack";
    const lib = path.join(home, "perl-lib");
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(
      path.join(lib, "pwn.pm"),
      `system("/usr/bin/printf ${token} > '${marker}'"); 1;\n`,
    );
    writeAllowlist(home, ["/usr/bin/perl"]);
    const outcome = await run("perl -e 'print \"ok\\n\"'", { PERL5OPT: `-I${lib} -Mpwn` }, home);
    assertPayloadDidNotRun(marker, token, outcome);
  });

  it("still runs a safe bin when the model sets a locale variable", async () => {
    const tool = await execTool();
    const result = await tool.execute("call", {
      command: "wc -l",
      env: { LANG: "C" },
      workdir: home,
    });
    expect(result.details.status).toBe("completed");
  });

  it("refuses the payload even when ask=always approves the command text", async () => {
    gatewayState.decision = "allow-once";
    const marker = path.join(home, "approved-marker");
    const token = "approved-text-hijack";
    const tool = await execTool();
    const result = await tool.execute("call", {
      command: "wc -l",
      env: { "BASH_FUNC_wc%%": bashFunction(`/usr/bin/printf ${token} > '${marker}'`) },
      workdir: home,
      ask: "always",
    });
    expect(result.details.status).toBe("approval-pending");
    await vi.waitFor(
      () => {
        expect(gatewayState.requests.some((call) => call.method === "exec.approval.request")).toBe(
          true,
        );
      },
      { timeout: 2000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    assertPayloadDidNotRun(marker, token, { text: "" });
  });

  it("sends the model env with the gateway approval request", async () => {
    gatewayState.decision = "deny";
    const tool = await execTool();
    await tool.execute("call", {
      command: "wc -l",
      env: { LANG: "C" },
      workdir: home,
      ask: "always",
    });
    await vi.waitFor(() => {
      expect(gatewayState.requests.some((call) => call.method === "exec.approval.request")).toBe(
        true,
      );
    });
    const approval = gatewayState.requests.find((call) => call.method === "exec.approval.request");
    expect(approval?.params).toMatchObject({ env: { LANG: "C" } });
  });

  it("keeps the model env on the approval that operators see", async () => {
    const params = {
      id: "approval-env-1",
      command: "wc -l",
      cwd: home,
      host: "gateway",
      env: { LANG: "C" },
    };
    expect(validateExecApprovalRequestParams(params)).toBe(true);
    const { ExecApprovalManager } = await import("../gateway/exec-approval-manager.js");
    const { createExecApprovalHandlers } =
      await import("../gateway/server-methods/exec-approval.js");
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const broadcasts: Array<{ event: string; payload: unknown }> = [];
    const pending = handlers["exec.approval.request"]({
      params,
      respond: () => {},
      context: {
        broadcast: (event: string, payload: unknown) => {
          broadcasts.push({ event, payload });
        },
      },
      client: null,
      req: { id: "req-1", type: "req", method: "exec.approval.request" },
      isWebchatConnect: () => false,
    } as never);
    await vi.waitFor(() => {
      expect(broadcasts.some((entry) => entry.event === "exec.approval.requested")).toBe(true);
    });
    expect(manager.resolve(params.id, "deny", null)).toBe(true);
    await pending;
    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    const request = (
      requested?.payload as { request?: { env?: Record<string, string> } } | undefined
    )?.request;
    expect(request?.env).toEqual({ LANG: "C" });
  });

  it("does not let allow-always authorize a later run with a different env", async () => {
    const script = path.join(home, "show-mode");
    const outFile = path.join(home, "mode-out");
    const approved = "approved-mode-value";
    const unapproved = "unapproved-mode-value";
    fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$MODE" > '${outFile}'\n`);
    fs.chmodSync(script, 0o755);
    writeAllowlist(home, [script]);
    gatewayState.decision = "allow-always";
    const tool = await execTool();
    const first = await tool.execute("call", {
      command: script,
      env: { MODE: approved },
      workdir: home,
      ask: "always",
    });
    expect(first.details.status).toBe("approval-pending");
    await vi.waitFor(
      () => {
        expect(fs.readFileSync(outFile, "utf8")).toContain(approved);
      },
      { timeout: 5000 },
    );
    fs.rmSync(outFile);
    gatewayState.decision = "deny";
    const second = await tool.execute("call", {
      command: script,
      env: { MODE: unapproved },
      workdir: home,
      ask: "on-miss",
    });
    if (second.details.status === "approval-pending") {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const written = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
    expect(written).not.toContain(unapproved);
  });

  it("sends the model env with the nodes tool approval request", async () => {
    gatewayState.nodeInvokeError = "SYSTEM_RUN_DENIED: approval required";
    gatewayState.decision = "deny";
    const { createNodesTool } = await import("./tools/nodes-tool.js");
    const tool = createNodesTool({ agentSessionKey: "agent:main:main" });
    await expect(
      tool.execute("call", {
        action: "run",
        node: "node-1",
        command: ["git", "status"],
        env: ["LANG=C"],
      }),
    ).rejects.toThrow(/denied/);
    const approval = gatewayState.requests.find((call) => call.method === "exec.approval.request");
    expect(approval?.params).toMatchObject({ env: { LANG: "C" } });
  });
});
