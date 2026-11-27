import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecToolDetails } from "./bash-tools.exec.js";

/**
 * Gateway exec in allowlist mode must not run heredoc bodies the shell expands,
 * or commands that follow a heredoc terminator. The shell is the real `/bin/bash`
 * or `/bin/sh` from getShellConfig(); these tests fail while the original
 * command string is executed after a satisfied allowlist check.
 */

const CAT = "/bin/cat";
const ECHO = "/bin/echo";

function writeApprovals(home: string) {
  const dir = path.join(home, ".openclaw");
  fs.mkdirSync(dir, { recursive: true });
  const file = {
    version: 1,
    defaults: {
      security: "allowlist" as const,
      ask: "off" as const,
      askFallback: "deny" as const,
      autoAllowSkills: false,
    },
    agents: {
      main: {
        security: "allowlist" as const,
        ask: "off" as const,
        allowlist: [{ pattern: CAT }, { pattern: ECHO }],
      },
    },
  };
  fs.writeFileSync(path.join(dir, "exec-approvals.json"), `${JSON.stringify(file, null, 2)}\n`, {
    mode: 0o600,
  });
}

describe("gateway exec allowlist heredoc bypass", () => {
  let home = "";
  let workdir = "";
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  const previousShellTimeout = process.env.OPENCLAW_SHELL_ENV_TIMEOUT_MS;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-heredoc-home-"));
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-heredoc-work-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.OPENCLAW_HOME = home;
    process.env.OPENCLAW_SHELL_ENV_TIMEOUT_MS = "2000";
    writeApprovals(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    if (previousShellTimeout === undefined) {
      delete process.env.OPENCLAW_SHELL_ENV_TIMEOUT_MS;
    } else {
      process.env.OPENCLAW_SHELL_ENV_TIMEOUT_MS = previousShellTimeout;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  async function exec(command: string): Promise<AgentToolResult<ExecToolDetails>> {
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "gateway",
      security: "allowlist",
      ask: "off",
      allowBackground: false,
      notifyOnExit: false,
    });
    return await tool.execute("heredoc-call", {
      command,
      workdir,
      timeout: 15,
    });
  }

  async function expectRefused(command: string, marker: string) {
    let message = "";
    try {
      await exec(command);
      message = "completed";
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(fs.existsSync(marker), message).toBe(false);
    expect(message).toMatch(/exec denied/);
  }

  it("runs an allowlisted command when the shell string has no heredoc expansion", async () => {
    const result = await exec(`${ECHO} ok`);
    expect(result.details.status).toBe("completed");
    const text = result.content.find((content) => content.type === "text")?.text ?? "";
    expect(text).toContain("ok");
  });

  it("does not expand a quoted heredoc body", async () => {
    const marker = path.join(workdir, "quoted-marker");
    const result = await exec(`${CAT} <<'EOF'\n$(touch '${marker}')\nEOF\n`);
    expect(result.details.status).toBe("completed");
    expect(fs.existsSync(marker)).toBe(false);
    const text = result.content.find((content) => content.type === "text")?.text ?? "";
    expect(text).toContain("$(touch");
  });

  it("refuses command substitution inside an unquoted heredoc before the shell runs it", async () => {
    const marker = path.join(workdir, "subst-marker");
    await expectRefused(`${CAT} <<EOF\n$(touch '${marker}')\nEOF\n`, marker);
  });

  it("refuses backticks inside an unquoted heredoc before the shell runs them", async () => {
    const marker = path.join(workdir, "tick-marker");
    await expectRefused(`${CAT} <<EOF\n\`touch '${marker}'\`\nEOF\n`, marker);
  });

  it("refuses command substitution in a strip-tabs heredoc before the shell runs it", async () => {
    const marker = path.join(workdir, "strip-marker");
    await expectRefused(`${CAT} <<-EOF\n\t$(touch '${marker}')\n\tEOF\n`, marker);
  });

  it("refuses parameter expansion inside an unquoted heredoc", async () => {
    await expect(exec(`${CAT} <<EOF\n\${HOME}\nEOF\n`)).rejects.toThrow(/exec denied/);
  });

  it("does not run a heredoc body when the binary is only a default safe bin", async () => {
    const marker = path.join(workdir, "safebin-marker");
    try {
      await exec(`/bin/head <<EOF\n$(touch '${marker}')\nEOF\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/exec denied/);
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refuses a command placed after the heredoc terminator", async () => {
    const marker = path.join(workdir, "trail-marker");
    await expectRefused(`${CAT} <<EOF\nhello\nEOF\ntouch '${marker}'`, marker);
  });

  it("refuses a command placed after a quoted heredoc terminator", async () => {
    const marker = path.join(workdir, "quoted-trail-marker");
    await expectRefused(`${CAT} <<'EOF'\nliteral\nEOF\ntouch '${marker}'`, marker);
  });

  it("refuses command substitution in a heredoc piped to another allowlisted binary", async () => {
    const marker = path.join(workdir, "pipe-marker");
    await expectRefused(`${CAT} <<EOF | ${ECHO}\n$(touch '${marker}')\nEOF\n`, marker);
  });
});
