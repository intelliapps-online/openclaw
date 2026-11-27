import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { AUTH_PROFILE_FILENAME } from "../agents/auth-profiles/constants.js";
import { buildEmbeddedRunPayloads } from "../agents/pi-embedded-runner/run/payloads.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { isToolAllowed } from "../agents/sandbox/tool-policy.js";
import { buildReplyPayloads } from "../auto-reply/reply/agent-runner-payloads.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionTranscriptPath } from "../config/sessions/paths.js";
import { sendDiscordMedia } from "../discord/send.shared.js";
import type { IMessageRpcClient } from "../imessage/client.js";
import { sendMessageIMessage } from "../imessage/send.js";
import type { RetryRunner } from "../infra/retry-policy.js";
import type { RuntimeEnv } from "../runtime.js";
import { sendMessageSignal } from "../signal/send.js";
import { sendMessageSlack } from "../slack/send.js";
import { deliverReplies } from "../telegram/bot/delivery.js";
import { sendMessageTelegram } from "../telegram/send.js";
import { setActiveWebListener } from "../web/active-listener.js";
import { deliverWebReply } from "../web/auto-reply/deliver-reply.js";
import type { WebInboundMsg } from "../web/auto-reply/types.js";
import { loadWebMedia, loadWebMediaRaw } from "../web/media.js";
import { sendMessageWhatsApp } from "../web/outbound.js";
import { getAgentScopedMediaLocalRoots } from "./local-roots.js";
import { resolveOutboundAttachmentFromUrl } from "./outbound-attachment.js";

const MARKER = "OPENCLAW_REPLY_MEDIA_MARKER";

type SecretPaths = {
  homeDir: string;
  stateDir: string;
  authPath: string;
  ownAuthPath: string;
  transcriptPath: string;
  otherSandboxPath: string;
  mediaDir: string;
};

const originalEnv = {
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
  OPENCLAW_HOME: process.env.OPENCLAW_HOME,
  HOME: process.env.HOME,
  CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR,
};

function restoreEnv(name: keyof typeof originalEnv, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function writeSecret(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${MARKER}\n`, "utf8");
}

async function directoryContainsMarker(root: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const child = path.join(root, entry);
    const stat = await fs.lstat(child);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      if (await directoryContainsMarker(child)) {
        return true;
      }
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    const body = await fs.readFile(child, "utf8");
    if (body.includes(MARKER)) {
      return true;
    }
  }
  return false;
}

function sandboxedConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: { mode: "all", workspaceAccess: "none" },
      },
    },
  };
}

const EXPOSED_AGENT_ID = "exposed";
const SESSION_KEY = "agent:exposed:telegram:group:1";

function fileBytes(file: unknown): string {
  if (!file || typeof file !== "object") {
    return "";
  }
  const record = file as { buffer?: Buffer; data?: Buffer; fileData?: Buffer };
  const buf = record.buffer ?? record.data ?? record.fileData;
  return Buffer.isBuffer(buf) ? buf.toString("utf8") : "";
}

function replyPayloadFor(text: string) {
  const embedded = buildEmbeddedRunPayloads({
    assistantTexts: [text],
    toolMetas: [],
    lastAssistant: undefined,
    config: sandboxedConfig(),
    sessionKey: SESSION_KEY,
    verboseLevel: "off",
    reasoningLevel: "off",
    toolResultFormat: "plain",
    inlineToolResultsAllowed: false,
  });
  return buildReplyPayloads({
    payloads: embedded,
    isHeartbeat: false,
    didLogHeartbeatStrip: false,
    blockStreamingEnabled: false,
    blockReplyPipeline: null,
    replyToMode: "off",
  }).replyPayloads;
}

function mediaUrlsFrom(text: string): string[] {
  const urls: string[] = [];
  for (const payload of replyPayloadFor(text)) {
    if (payload.mediaUrl) {
      urls.push(payload.mediaUrl);
    }
    for (const url of payload.mediaUrls ?? []) {
      if (url) {
        urls.push(url);
      }
    }
  }
  return [...new Set(urls)];
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function createSecrets(): Promise<SecretPaths> {
  // Keep this outside os.tmpdir(). The default media roots include the temp
  // directory, so a state dir created there would be allowed for that reason.
  // Vitest isolates HOME under os.tmpdir(), and the default media roots allow
  // that temp directory. Put the state dir in the workspace instead so a read
  // is not explained by the temp root.
  const homeParent = path.resolve(process.cwd());
  if (isInside(os.tmpdir(), homeParent)) {
    throw new Error("workspace is inside the temp media root; refusing an ambiguous test");
  }
  const homeDir = await fs.mkdtemp(path.join(homeParent, ".openclaw-reply-media-"));
  const stateDir = path.join(homeDir, ".openclaw");
  process.env.OPENCLAW_HOME = homeDir;
  process.env.HOME = homeDir;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  delete process.env.CLAWDBOT_STATE_DIR;

  const cfg = sandboxedConfig();
  const authPath = path.join(resolveAgentDir(cfg, "main"), AUTH_PROFILE_FILENAME);
  const ownAuthPath = path.join(resolveAgentDir(cfg, EXPOSED_AGENT_ID), AUTH_PROFILE_FILENAME);
  const transcriptPath = resolveSessionTranscriptPath("sess-other", "main");
  const otherSandboxPath = path.join(stateDir, "sandboxes", "agent-other", "note.txt");
  await writeSecret(authPath);
  await writeSecret(ownAuthPath);
  await writeSecret(transcriptPath);
  await writeSecret(otherSandboxPath);
  return {
    homeDir,
    stateDir,
    authPath,
    ownAuthPath,
    transcriptPath,
    otherSandboxPath,
    mediaDir: path.join(stateDir, "media"),
  };
}

type Leak = { operation: string; detail: string };

async function withReadSpy<T>(
  run: () => Promise<T>,
): Promise<{ result: T | undefined; error: unknown; reads: string[] }> {
  const reads: string[] = [];
  const original = fs.readFile.bind(fs);
  const spy = vi.spyOn(fs, "readFile").mockImplementation(((
    ...args: Parameters<typeof fs.readFile>
  ) => {
    const target = args[0];
    if (typeof target === "string") {
      reads.push(target);
    } else if (target instanceof URL) {
      reads.push(target.pathname);
    }
    return original(...args);
  }) as typeof fs.readFile);
  try {
    const result = await run();
    return { result, error: undefined, reads };
  } catch (error) {
    return { result: undefined, error, reads };
  } finally {
    spy.mockRestore();
  }
}

async function leakedHostFile(params: {
  operation: string;
  reads: string[];
  mediaDir: string;
  sinks: string[];
}): Promise<Leak | undefined> {
  for (const readPath of params.reads) {
    try {
      const body = await fs.readFile(readPath, "utf8");
      if (body.includes(MARKER)) {
        return { operation: params.operation, detail: `read ${readPath}` };
      }
    } catch {
      // Unreadable path or a directory. The content check is what matters.
    }
  }
  for (const sink of params.sinks) {
    if (sink.includes(MARKER)) {
      return { operation: params.operation, detail: "channel send received the host file bytes" };
    }
  }
  if (await directoryContainsMarker(params.mediaDir)) {
    return { operation: params.operation, detail: `copied the host file under ${params.mediaDir}` };
  }
  return undefined;
}

function secretTargets(secrets: SecretPaths): Array<{ label: string; replyText: string }> {
  const tildeAuth = `~/.openclaw/agents/main/agent/${AUTH_PROFILE_FILENAME}`;
  return [
    { label: "main auth store absolute path", replyText: `MEDIA:${secrets.authPath}` },
    { label: "sandboxed agent auth store", replyText: `Here\nMEDIA:${secrets.ownAuthPath}` },
    { label: "tilde auth store", replyText: `MEDIA:${tildeAuth}` },
    { label: "file URL auth store", replyText: `MEDIA:file://${secrets.authPath}` },
    { label: "other agent session transcript", replyText: `MEDIA:${secrets.transcriptPath}` },
    { label: "other sandbox file", replyText: `MEDIA:${secrets.otherSandboxPath}` },
  ];
}

describe("sandboxed reply media host-file boundary", () => {
  let secrets: SecretPaths;

  beforeEach(async () => {
    secrets = await createSecrets();
    const runtime = resolveSandboxRuntimeStatus({
      cfg: sandboxedConfig(),
      sessionKey: SESSION_KEY,
    });
    expect(runtime.sandboxed).toBe(true);
    expect(runtime.agentId).toBe(EXPOSED_AGENT_ID);
    expect(isToolAllowed(runtime.toolPolicy, "message")).toBe(false);
    for (const secretPath of [
      secrets.authPath,
      secrets.ownAuthPath,
      secrets.transcriptPath,
      secrets.otherSandboxPath,
    ]) {
      expect(isInside(os.tmpdir(), secretPath)).toBe(false);
      expect(secretPath.startsWith(secrets.stateDir + path.sep)).toBe(true);
    }
  });

  afterEach(async () => {
    setActiveWebListener(null);
    restoreEnv("OPENCLAW_STATE_DIR", originalEnv.OPENCLAW_STATE_DIR);
    restoreEnv("OPENCLAW_HOME", originalEnv.OPENCLAW_HOME);
    restoreEnv("HOME", originalEnv.HOME);
    restoreEnv("CLAWDBOT_STATE_DIR", originalEnv.CLAWDBOT_STATE_DIR);
    if (secrets?.homeDir) {
      await fs.rm(secrets.homeDir, { recursive: true, force: true });
    }
  });

  async function assertReplyMediaStaysInsideSandbox(
    operation: string,
    deliver: (mediaUrl: string, roots: readonly string[]) => Promise<string[]>,
  ) {
    const roots = getAgentScopedMediaLocalRoots(sandboxedConfig(), EXPOSED_AGENT_ID);
    const leaks: Leak[] = [];
    for (const target of secretTargets(secrets)) {
      const urls = mediaUrlsFrom(target.replyText);
      if (urls.length === 0) {
        continue;
      }
      for (const mediaUrl of urls) {
        const captured: string[] = [];
        const outcome = await withReadSpy(() => deliver(mediaUrl, roots));
        captured.push(...(outcome.result ?? []));
        const leak = await leakedHostFile({
          operation: `${operation} (${target.label})`,
          reads: outcome.reads,
          mediaDir: secrets.mediaDir,
          sinks: captured,
        });
        if (leak) {
          leaks.push(leak);
        }
        if (secrets.mediaDir) {
          await fs.rm(secrets.mediaDir, { recursive: true, force: true });
        }
      }
    }
    expect(leaks).toEqual([]);
  }

  it("rejects host files under the default and agent-scoped media roots", async () => {
    const roots = getAgentScopedMediaLocalRoots(sandboxedConfig(), EXPOSED_AGENT_ID);
    const leaks: Leak[] = [];
    for (const target of secretTargets(secrets)) {
      const urls = mediaUrlsFrom(target.replyText);
      const candidates = urls.length > 0 ? urls : [target.replyText.replace(/^MEDIA:/, "")];
      for (const mediaUrl of candidates) {
        for (const load of [
          { name: "loadWebMedia default roots", run: () => loadWebMedia(mediaUrl) },
          {
            name: "loadWebMedia agent roots",
            run: () => loadWebMedia(mediaUrl, { localRoots: roots }),
          },
          { name: "loadWebMediaRaw default roots", run: () => loadWebMediaRaw(mediaUrl) },
          {
            name: "loadWebMediaRaw agent roots",
            run: () => loadWebMediaRaw(mediaUrl, { localRoots: roots }),
          },
        ]) {
          const outcome = await withReadSpy(load.run);
          const returned = outcome.result?.buffer?.toString("utf8") ?? "";
          const leak = await leakedHostFile({
            operation: `${load.name} (${target.label})`,
            reads: outcome.reads,
            mediaDir: secrets.mediaDir,
            sinks: [returned],
          });
          if (leak) {
            leaks.push(leak);
          }
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("does not upload host files from telegram reply delivery", async () => {
    await assertReplyMediaStaysInsideSandbox("telegram deliverReplies", async (mediaUrl, roots) => {
      const sent: string[] = [];
      const capture = async (_chatId: string, file: unknown) => {
        const text = fileBytes(file);
        if (text) {
          sent.push(text);
        }
        return { message_id: 1, chat: { id: "1" } };
      };
      const runtime: RuntimeEnv = { error: () => {}, log: () => {}, exit: () => {} };
      await deliverReplies({
        replies: [{ mediaUrl }],
        chatId: "1",
        token: "placeholder-token",
        runtime,
        bot: {
          api: {
            sendDocument: capture,
            sendPhoto: capture,
            sendVideo: capture,
            sendAudio: capture,
            sendAnimation: capture,
            sendVoice: capture,
            sendMessage: async () => ({ message_id: 1, chat: { id: "1" } }),
          },
        } as unknown as Parameters<typeof deliverReplies>[0]["bot"],
        mediaLocalRoots: roots,
        replyToMode: "off",
        textLimit: 4000,
      });
      return sent;
    });
  });

  it("does not upload host files from telegram outbound send", async () => {
    await assertReplyMediaStaysInsideSandbox(
      "telegram sendMessageTelegram",
      async (mediaUrl, roots) => {
        const sent: string[] = [];
        const capture = async (_chatId: string, file: unknown) => {
          const text = fileBytes(file);
          if (text) {
            sent.push(text);
          }
          return { message_id: 1, chat: { id: "1" } };
        };
        await sendMessageTelegram("1", "", {
          token: "placeholder-token",
          mediaUrl,
          mediaLocalRoots: roots,
          api: {
            sendDocument: capture,
            sendPhoto: capture,
            sendVideo: capture,
            sendAudio: capture,
            sendAnimation: capture,
            sendVoice: capture,
            sendMessage: async () => ({ message_id: 1, chat: { id: "1" } }),
          } as unknown as NonNullable<Parameters<typeof sendMessageTelegram>[2]["api"]>,
        });
        return sent;
      },
    );
  });

  it("does not upload host files from whatsapp inbound reply delivery", async () => {
    await assertReplyMediaStaysInsideSandbox(
      "whatsapp deliverWebReply",
      async (mediaUrl, roots) => {
        const sent: string[] = [];
        const msg = {
          from: "+15555550100",
          to: "+15555550101",
          id: "msg-1",
          reply: async (text: string) => {
            sent.push(text);
          },
          sendMedia: async (payload: {
            document?: Buffer;
            image?: Buffer;
            audio?: Buffer;
            video?: Buffer;
          }) => {
            const buf = payload.document ?? payload.image ?? payload.audio ?? payload.video;
            if (buf) {
              sent.push(buf.toString("utf8"));
            }
          },
        } as unknown as WebInboundMsg;
        await deliverWebReply({
          replyResult: { mediaUrl },
          msg,
          mediaLocalRoots: roots,
          maxMediaBytes: 1024 * 1024,
          textLimit: 4000,
          replyLogger: { info: () => {}, warn: () => {} },
        });
        return sent;
      },
    );
  });

  it("does not upload host files from whatsapp outbound send", async () => {
    await assertReplyMediaStaysInsideSandbox(
      "whatsapp sendMessageWhatsApp",
      async (mediaUrl, roots) => {
        const sent: string[] = [];
        setActiveWebListener({
          sendComposingTo: async () => {},
          sendPoll: async () => ({ messageId: "p1" }),
          sendReaction: async () => {},
          sendMessage: async (_to, _text, mediaBuffer) => {
            if (mediaBuffer) {
              sent.push(mediaBuffer.toString("utf8"));
            }
            return { messageId: "m1" };
          },
        });
        await sendMessageWhatsApp("+15555550100", "", {
          verbose: false,
          mediaUrl,
          mediaLocalRoots: roots,
        });
        return sent;
      },
    );
  });

  it("does not upload host files from discord media send", async () => {
    await assertReplyMediaStaysInsideSandbox(
      "discord sendDiscordMedia",
      async (mediaUrl, roots) => {
        const sent: string[] = [];
        const rest = {
          post: async (_route: string, opts: { body?: unknown }) => {
            sent.push(JSON.stringify(opts.body ?? {}));
            return { id: "1", channel_id: "1" };
          },
        };
        const request: RetryRunner = async (fn) => fn();
        await sendDiscordMedia(
          rest as unknown as Parameters<typeof sendDiscordMedia>[0],
          "1",
          "",
          mediaUrl,
          roots,
          undefined,
          request,
        );
        return sent;
      },
    );
  });

  it("does not upload host files from slack outbound send", async () => {
    await assertReplyMediaStaysInsideSandbox("slack sendMessageSlack", async (mediaUrl, roots) => {
      const sent: string[] = [];
      const client = {
        files: {
          uploadV2: async (args: { file?: Buffer }) => {
            if (args.file) {
              sent.push(args.file.toString("utf8"));
            }
            return { files: [{ id: "F1" }] };
          },
        },
      };
      await sendMessageSlack("channel:C0123456789", "", {
        token: "placeholder-token",
        client: client as unknown as NonNullable<Parameters<typeof sendMessageSlack>[2]["client"]>,
        mediaUrl,
        mediaLocalRoots: roots,
      });
      return sent;
    });
  });

  it("does not copy host files into outbound attachments for signal", async () => {
    await assertReplyMediaStaysInsideSandbox("signal attachment", async (mediaUrl, roots) => {
      await resolveOutboundAttachmentFromUrl(mediaUrl, 1024 * 1024, { localRoots: roots });
      await sendMessageSignal("+15555550100", "", {
        mediaUrl,
        mediaLocalRoots: roots,
        baseUrl: "http://127.0.0.1:9",
        timeoutMs: 500,
      });
      return [];
    });
  });

  it("does not attach host files for imessage", async () => {
    await assertReplyMediaStaysInsideSandbox("imessage send", async (mediaUrl, roots) => {
      const sent: string[] = [];
      const client = {
        request: async (_method: string, params: { file?: string }) => {
          if (params?.file) {
            sent.push(await fs.readFile(params.file, "utf8"));
          }
          return { ok: "ok" };
        },
        stop: async () => {},
      } as unknown as IMessageRpcClient;
      await sendMessageIMessage("+15555550100", "", {
        mediaUrl,
        mediaLocalRoots: roots,
        client,
        config: {},
      });
      return sent;
    });
  });
});
