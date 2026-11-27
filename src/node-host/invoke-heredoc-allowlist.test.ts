import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigCache } from "../config/config.js";
import type { GatewayClient } from "../gateway/client.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import { handleInvoke, type SkillBinsProvider } from "./invoke.js";

/**
 * Headless node `system.run` must refuse the same heredoc allowlist bypass.
 * On Linux the node executes `/bin/sh -lc` with the original command string.
 * macOS companion-app exec and Windows PowerShell parsing are not covered here.
 */

const CAT = "/bin/cat";
const HEAD = "/bin/head";

type InvokeResult = {
  ok?: boolean;
  error?: { message?: string };
  payloadJSON?: string;
};

function writeState(home: string, params: { allowlist: string[]; autoAllowSkills: boolean }) {
  const dir = path.join(home, ".openclaw");
  fs.mkdirSync(dir, { recursive: true });
  const approvals = {
    version: 1,
    defaults: {
      security: "allowlist" as const,
      ask: "off" as const,
      askFallback: "deny" as const,
      autoAllowSkills: params.autoAllowSkills,
    },
    agents: {
      main: {
        security: "allowlist" as const,
        ask: "off" as const,
        autoAllowSkills: params.autoAllowSkills,
        allowlist: params.allowlist.map((pattern) => ({ pattern })),
      },
    },
  };
  fs.writeFileSync(
    path.join(dir, "exec-approvals.json"),
    `${JSON.stringify(approvals, null, 2)}\n`,
    { mode: 0o600 },
  );
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        tools: {
          exec: {
            security: "allowlist",
            ask: "off",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return configPath;
}

function mockClient() {
  const results: InvokeResult[] = [];
  const client = {
    request: async (method: string, params: InvokeResult) => {
      if (method === "node.invoke.result") {
        results.push(params);
      }
      return { ok: true };
    },
  };
  return { client: client as unknown as GatewayClient, results };
}

describe("node host exec allowlist heredoc bypass", () => {
  let home = "";
  let workdir = "";
  let configPath = "";
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_DISABLE_CONFIG_CACHE: process.env.OPENCLAW_DISABLE_CONFIG_CACHE,
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-heredoc-home-"));
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-heredoc-work-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.OPENCLAW_HOME = home;
    process.env.OPENCLAW_DISABLE_CONFIG_CACHE = "1";
    configPath = writeState(home, { allowlist: [CAT], autoAllowSkills: false });
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    clearConfigCache();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    clearConfigCache();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  async function runSystem(
    command: string,
    skillBins: SkillBinsProvider = { current: async () => new Set<string>() },
  ) {
    const { client, results } = mockClient();
    const argv = buildNodeShellCommand(command, "linux");
    await handleInvoke(
      {
        id: "invoke-heredoc",
        nodeId: "node-heredoc",
        command: "system.run",
        paramsJSON: JSON.stringify({
          command: argv,
          rawCommand: command,
          cwd: workdir,
          agentId: "main",
          sessionKey: "agent:main:main",
          timeoutMs: 15_000,
        }),
      },
      client,
      skillBins,
    );
    return results.at(-1);
  }

  function expectRefused(result: InvokeResult | undefined, marker: string) {
    expect(fs.existsSync(marker)).toBe(false);
    expect(result?.ok).toBe(false);
    expect(result?.error?.message ?? "").toMatch(/SYSTEM_RUN_DENIED|approval required/);
  }

  it("does not expand a quoted heredoc when cat is allowlisted", async () => {
    if (process.platform !== "linux") {
      return;
    }
    const marker = path.join(workdir, "quoted-marker");
    const command = `${CAT} <<'EOF'\n$(touch '${marker}')\nEOF\n`;
    const result = await runSystem(command);
    expect(result?.ok).toBe(true);
    const payload = JSON.parse(result?.payloadJSON ?? "{}") as {
      stdout?: string;
      success?: boolean;
    };
    expect(payload.success).toBe(true);
    expect(payload.stdout ?? "").toContain("$(touch");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refuses command substitution in an unquoted heredoc before sh runs it", async () => {
    if (process.platform !== "linux") {
      return;
    }
    const marker = path.join(workdir, "subst-marker");
    const result = await runSystem(`${CAT} <<EOF\n$(touch '${marker}')\nEOF\n`);
    expectRefused(result, marker);
  });

  it("refuses backticks in an unquoted heredoc before sh runs them", async () => {
    if (process.platform !== "linux") {
      return;
    }
    const marker = path.join(workdir, "tick-marker");
    const result = await runSystem(`${CAT} <<EOF\n\`touch '${marker}'\`\nEOF\n`);
    expectRefused(result, marker);
  });

  it("refuses a command placed after the heredoc terminator", async () => {
    if (process.platform !== "linux") {
      return;
    }
    const marker = path.join(workdir, "trail-marker");
    const result = await runSystem(`${CAT} <<EOF\nhello\nEOF\ntouch '${marker}'`);
    expectRefused(result, marker);
  });

  it("refuses an unquoted heredoc on a default safe bin when nothing is allowlisted", async () => {
    if (process.platform !== "linux") {
      return;
    }
    configPath = writeState(home, { allowlist: [], autoAllowSkills: false });
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    clearConfigCache();
    const marker = path.join(workdir, "safebin-marker");
    const result = await runSystem(`${HEAD} <<EOF\n$(touch '${marker}')\nEOF\n`);
    expectRefused(result, marker);
  });

  it("refuses an unquoted heredoc when the binary is only auto-allowed as a skill", async () => {
    if (process.platform !== "linux") {
      return;
    }
    configPath = writeState(home, { allowlist: [], autoAllowSkills: true });
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    clearConfigCache();
    const marker = path.join(workdir, "skill-marker");
    const result = await runSystem(`${CAT} <<EOF\n$(touch '${marker}')\nEOF\n`, {
      current: async () => new Set(["cat"]),
    });
    expectRefused(result, marker);
  });
});
