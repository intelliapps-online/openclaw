import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";
import { runWithSandboxReplyMediaGuard } from "./pi-embedded-runner/run/sandbox-reply-media.js";
import { stageSandboxedMediaFile } from "./sandbox-media.js";
import { createSandboxReplyMediaGuard, stageSandboxedReplyText } from "./sandbox-reply-media.js";
import { resolveSandboxWorkspaceDirForSession } from "./sandbox/context.js";

let tmpRoot = "";
let sandboxRoot = "";
let hostFile = "";

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sbx-media-test-"));
  sandboxRoot = path.join(tmpRoot, "sandbox");
  await fs.mkdir(path.join(sandboxRoot, "out"), { recursive: true });
  await fs.writeFile(path.join(sandboxRoot, "out", "chart.png"), "sandbox-chart");
  hostFile = path.join(tmpRoot, "host-only.txt");
  await fs.writeFile(hostFile, "host-only");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("stageSandboxedMediaFile", () => {
  it("copies a sandbox file to a gateway-owned path", async () => {
    const staged = await stageSandboxedMediaFile({
      filePath: path.join(sandboxRoot, "out", "chart.png"),
      sandboxRoot,
    });
    expect(staged.startsWith(sandboxRoot + path.sep)).toBe(false);
    expect(path.basename(staged)).toBe("chart.png");
    expect(await fs.readFile(staged, "utf8")).toBe("sandbox-chart");
    const again = await stageSandboxedMediaFile({
      filePath: path.join(sandboxRoot, "out", "chart.png"),
      sandboxRoot,
    });
    expect(again).toBe(staged);
  });

  it("refuses symlinks that leave the sandbox", async () => {
    await fs.symlink(hostFile, path.join(sandboxRoot, "out", "link.txt"));
    await fs.symlink(tmpRoot, path.join(sandboxRoot, "escape"));
    await expect(
      stageSandboxedMediaFile({ filePath: path.join(sandboxRoot, "out", "link.txt"), sandboxRoot }),
    ).rejects.toThrow();
    await expect(
      stageSandboxedMediaFile({
        filePath: path.join(sandboxRoot, "escape", "host-only.txt"),
        sandboxRoot,
      }),
    ).rejects.toThrow();
  });

  it("refuses paths outside the sandbox", async () => {
    await expect(stageSandboxedMediaFile({ filePath: hostFile, sandboxRoot })).rejects.toThrow();
  });
});

describe("createSandboxReplyMediaGuard", () => {
  it("stages sandbox files, keeps remote URLs, and drops host paths", async () => {
    const guard = createSandboxReplyMediaGuard({ sandboxRoot });
    const staged = await guard.stagePayload({
      text: "here",
      mediaUrls: [
        "./out/chart.png",
        "https://example.com/a.png",
        hostFile,
        `file://${hostFile}`,
        "~/.openclaw/agents/main/agent/auth-profiles.json",
        path.join(sandboxRoot, "..", "host-only.txt"),
      ],
    });
    expect(staged?.text).toBe("here");
    expect(staged?.mediaUrls).toHaveLength(2);
    expect(staged?.mediaUrls?.[1]).toBe("https://example.com/a.png");
    const local = staged?.mediaUrls?.[0] ?? "";
    expect(local.startsWith(sandboxRoot + path.sep)).toBe(false);
    expect(await fs.readFile(local, "utf8")).toBe("sandbox-chart");
  });

  it("drops a media-only payload whose media is all outside the sandbox", async () => {
    const guard = createSandboxReplyMediaGuard({ sandboxRoot });
    await expect(guard.stagePayload({ mediaUrl: hostFile, mediaUrls: [hostFile] })).resolves.toBe(
      null,
    );
  });

  it("rewrites MEDIA lines in relayed text", async () => {
    const guard = createSandboxReplyMediaGuard({ sandboxRoot });
    const text = await guard.stageText(`Done\nMEDIA:./out/chart.png\nMEDIA:${hostFile}`);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Done");
    expect(lines).toHaveLength(2);
    expect(lines[1]?.startsWith("MEDIA:")).toBe(true);
    expect(lines[1]).not.toContain(hostFile);
    expect(await fs.readFile((lines[1] ?? "").slice("MEDIA:".length), "utf8")).toBe(
      "sandbox-chart",
    );
  });
});

describe("sandboxed run media boundary", () => {
  const sessionKey = "agent:main:telegram:group:1";

  function sandboxedConfig(): OpenClawConfig {
    return {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent", workspaceAccess: "none", workspaceRoot: tmpRoot },
        },
      },
    };
  }

  it("stages block, tool and final media inside the session sandbox only", async () => {
    const cfg = sandboxedConfig();
    const workspaceDir = path.join(tmpRoot, "agent-workspace");
    const sessionSandbox = resolveSandboxWorkspaceDirForSession({
      config: cfg,
      sessionKey,
      workspaceDir,
    });
    expect(sessionSandbox).toBeTruthy();
    await fs.mkdir(sessionSandbox!, { recursive: true });
    await fs.writeFile(path.join(sessionSandbox!, "result.txt"), "session-result");

    const blocks: Array<string[] | undefined> = [];
    const tools: Array<string[] | undefined> = [];
    const runParams: Partial<RunEmbeddedPiAgentParams> = {
      config: cfg,
      sessionKey,
      sessionId: "s1",
      workspaceDir,
      onBlockReply: (payload) => {
        blocks.push(payload.mediaUrls);
      },
      onToolResult: (payload) => {
        tools.push(payload.mediaUrls);
      },
    };
    const result = await runWithSandboxReplyMediaGuard(
      runParams as RunEmbeddedPiAgentParams,
      async (params) => {
        await params.onBlockReply?.({ text: "block", mediaUrls: [hostFile] });
        await params.onBlockReply?.({ mediaUrls: ["./result.txt"] });
        await params.onToolResult?.({ mediaUrls: [hostFile] });
        return {
          payloads: [
            { text: "final", mediaUrl: hostFile, mediaUrls: [hostFile, "./result.txt"] },
            { mediaUrl: hostFile, mediaUrls: [hostFile] },
          ],
          meta: { durationMs: 1 },
        };
      },
    );

    expect(blocks[0]).toBeUndefined();
    expect(blocks).toHaveLength(2);
    expect(await fs.readFile(blocks[1]?.[0] ?? "", "utf8")).toBe("session-result");
    expect(tools).toHaveLength(0);
    expect(result.payloads).toHaveLength(1);
    const final = result.payloads?.[0];
    expect(final?.mediaUrls).toEqual([blocks[1]?.[0]]);
    expect(final?.mediaUrl).toBe(blocks[1]?.[0]);
  });

  it("leaves unsandboxed runs untouched", async () => {
    const payloads = [{ text: "x", mediaUrl: hostFile, mediaUrls: [hostFile] }];
    const result = await runWithSandboxReplyMediaGuard(
      {
        config: {},
        sessionKey,
        sessionId: "s1",
        workspaceDir: tmpRoot,
      } as RunEmbeddedPiAgentParams,
      async () => ({ payloads, meta: { durationMs: 1 } }),
    );
    expect(result.payloads).toBe(payloads);
  });

  it("stages relayed text only for sandboxed sessions", async () => {
    const text = `Result\nMEDIA:${hostFile}`;
    await expect(stageSandboxedReplyText({ text, config: {}, sessionKey })).resolves.toBe(text);
    await expect(
      stageSandboxedReplyText({ text, config: sandboxedConfig(), sessionKey }),
    ).resolves.toBe("Result");
  });
});
