/**
 * Webhook authentication for Feishu.
 *
 * These tests exercise the real HTTP server, the shipped Lark event dispatcher,
 * and handleFeishuMessage. They fail while an unsigned im.message.receive_v1
 * event is accepted when encryptKey is missing. The agent model is not run:
 * dispatchReplyFromConfig is the boundary that records the sender the product
 * was about to run as.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHumanDelayConfig } from "../../../src/agents/identity.js";
import {
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../../../src/auto-reply/chunk.js";
import { shouldComputeCommandAuthorized } from "../../../src/auto-reply/command-detection.js";
import {
  formatAgentEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../../src/auto-reply/envelope.js";
import { finalizeInboundContext } from "../../../src/auto-reply/reply/inbound-context.js";
import { createReplyDispatcherWithTyping } from "../../../src/auto-reply/reply/reply-dispatcher.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../../src/channels/command-gating.js";
import { resolveMarkdownTableMode } from "../../../src/config/markdown-tables.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "../../../src/infra/system-events.js";
import { convertMarkdownTables } from "../../../src/markdown/tables.js";
import { readChannelAllowFromStore } from "../../../src/pairing/pairing-store.js";
import { resolveAgentRoute } from "../../../src/routing/resolve-route.js";
import { clearClientCache } from "./client.js";
import { monitorFeishuProvider, stopFeishuMonitor } from "./monitor.js";
import { setFeishuRuntime } from "./runtime.js";

const APP_ID = "cli_placeholder";
const APP_SECRET = "placeholder_app_secret";
const ENCRYPT_KEY = "placeholder-encrypt-key";
const VERIFICATION_TOKEN = "placeholder-verification-token";
/** Closed local port so bot and sender lookups never leave this machine. */
const LOCAL_API = "https://127.0.0.1:1";
const WEBHOOK_PATH = "/feishu/events";

type FeishuOverrides = Record<string, unknown>;

type DispatchRecord = {
  senderId?: string;
  bodyForAgent?: string;
  chatType?: string;
  originatingTo?: string;
};

type WebhookResult = {
  listening: boolean;
  startupError?: string;
  status?: number;
  responseBody?: string;
  dispatches: DispatchRecord[];
  systemEvents: string[];
  listenAddresses: string[];
};

const runtimeLog = () => {};

function runtimeEnv(): RuntimeEnv {
  return {
    log: runtimeLog,
    error: runtimeLog,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
}

function installRuntime(records: { dispatches: DispatchRecord[]; systemEvents: string[] }) {
  setFeishuRuntime({
    system: {
      enqueueSystemEvent: (
        text: string,
        options: { sessionKey: string; contextKey?: string | null },
      ) => {
        records.systemEvents.push(text);
        enqueueSystemEvent(text, options);
      },
    },
    channel: {
      text: {
        resolveTextChunkLimit,
        resolveChunkMode,
        resolveMarkdownTableMode,
        chunkTextWithMode,
        convertMarkdownTables,
      },
      reply: {
        resolveEnvelopeFormatOptions,
        formatAgentEnvelope,
        finalizeInboundContext,
        createReplyDispatcherWithTyping,
        resolveHumanDelayConfig,
        dispatchReplyFromConfig: async (params: { ctx: Record<string, unknown> }) => {
          records.dispatches.push({
            senderId: typeof params.ctx.SenderId === "string" ? params.ctx.SenderId : undefined,
            bodyForAgent:
              typeof params.ctx.BodyForAgent === "string" ? params.ctx.BodyForAgent : undefined,
            chatType: typeof params.ctx.ChatType === "string" ? params.ctx.ChatType : undefined,
            originatingTo:
              typeof params.ctx.OriginatingTo === "string" ? params.ctx.OriginatingTo : undefined,
          });
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        },
      },
      routing: { resolveAgentRoute },
      pairing: {
        readAllowFromStore: (channel: string) => readChannelAllowFromStore(channel as "feishu"),
      },
      commands: {
        shouldComputeCommandAuthorized,
        resolveCommandAuthorizedFromAuthorizers,
      },
    },
  } as unknown as PluginRuntime);
}

function baseFeishu(port: number, overrides: FeishuOverrides = {}): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        appId: APP_ID,
        appSecret: APP_SECRET,
        domain: LOCAL_API,
        connectionMode: "webhook",
        webhookPath: WEBHOOK_PATH,
        webhookPort: port,
        ...overrides,
      },
    },
  } as ClawdbotConfig;
}

function messageEvent(params: {
  openId: string;
  chatId: string;
  chatType: "p2p" | "group";
  text: string;
  messageId: string;
}) {
  return {
    schema: "2.0",
    header: {
      event_id: `evt_${params.messageId}`,
      event_type: "im.message.receive_v1",
      create_time: "1700000000000",
      token: "untrusted-header-token",
      app_id: APP_ID,
      tenant_key: "tenant_placeholder",
    },
    event: {
      sender: {
        sender_id: { open_id: params.openId },
        sender_type: "user",
        tenant_key: "tenant_placeholder",
      },
      message: {
        message_id: params.messageId,
        chat_id: params.chatId,
        chat_type: params.chatType,
        message_type: "text",
        content: JSON.stringify({ text: params.text }),
      },
    },
  };
}

/**
 * Same bytes the Lark SDK 1.59.0 dispatcher hashes in RequestHandle.checkIsEventValidated:
 * sha256(timestamp + nonce + encryptKey + JSON.stringify(parsedBody)).
 */
function signBody(rawBody: string, timestamp: string, nonce: string, encryptKey: string): string {
  return crypto
    .createHash("sha256")
    .update(timestamp + nonce + encryptKey + rawBody)
    .digest("hex");
}

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  if (!port) {
    throw new Error("failed to reserve a port");
  }
  return port;
}

function listenAddresses(port: number): string[] {
  const portHex = port.toString(16).padStart(4, "0");
  const found: string[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) {
        continue;
      }
      const [addr, portPart] = parts[1]?.split(":") ?? [];
      if (!addr || portPart?.toLowerCase() !== portHex) {
        continue;
      }
      // 0A is TCP_LISTEN.
      if (parts[3] !== "0A") {
        continue;
      }
      found.push(addr.toLowerCase());
    }
  }
  return found;
}

function isLoopbackAddress(hex: string): boolean {
  return hex === "0100007f" || hex === "00000000000000000000000000000001";
}

async function portOpen(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function postRaw(
  port: number,
  rawBody: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: WEBHOOK_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(rawBody),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(rawBody);
  });
}

let messageSeq = 0;
function nextMessageId(): string {
  messageSeq += 1;
  return `om_webhook_${messageSeq}`;
}

async function exerciseWebhook(params: {
  port: number;
  cfg: ClawdbotConfig;
  accountId?: string;
  rawBody: string;
  headers?: Record<string, string>;
  /** When true, return as soon as a dispatch or system event is recorded. */
  settleOnEffect?: boolean;
}): Promise<WebhookResult> {
  const records = { dispatches: [] as DispatchRecord[], systemEvents: [] as string[] };
  installRuntime(records);
  const abort = new AbortController();
  let startupError: string | undefined;
  const done = monitorFeishuProvider({
    config: params.cfg,
    runtime: runtimeEnv(),
    abortSignal: abort.signal,
    accountId: params.accountId,
  }).catch((err: unknown) => {
    startupError = err instanceof Error ? err.message : String(err);
  });

  const listening = await waitForPort(params.port, 2_000);
  let status: number | undefined;
  let responseBody: string | undefined;
  if (listening) {
    const response = await postRaw(params.port, params.rawBody, params.headers ?? {});
    status = response.status;
    responseBody = response.body;
    const deadline = Date.now() + (params.settleOnEffect ? 3_000 : 1_000);
    while (Date.now() < deadline) {
      if (
        params.settleOnEffect &&
        (records.dispatches.length > 0 || records.systemEvents.length > 0)
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const addresses = listenAddresses(params.port);
  abort.abort();
  await done;
  stopFeishuMonitor(params.accountId);
  return {
    listening,
    startupError,
    status,
    responseBody,
    dispatches: records.dispatches,
    systemEvents: records.systemEvents,
    listenAddresses: addresses,
  };
}

function expectNoTrustedDelivery(result: WebhookResult) {
  expect(result.dispatches, JSON.stringify(result)).toEqual([]);
  expect(result.systemEvents, JSON.stringify(result)).toEqual([]);
}

describe("Feishu webhook authentication", () => {
  afterEach(() => {
    stopFeishuMonitor();
    clearClientCache();
    resetSystemEventsForTest();
  });

  it("does not run an agent for an unsigned DM when dmPolicy is open", async () => {
    const port = await reservePort();
    const result = await exerciseWebhook({
      port,
      accountId: "default",
      cfg: baseFeishu(port, { dmPolicy: "open", allowFrom: ["*"] }),
      rawBody: JSON.stringify(
        messageEvent({
          openId: "ou_untrusted_stranger",
          chatId: "oc_dm_placeholder",
          chatType: "p2p",
          text: "forged open dm",
          messageId: nextMessageId(),
        }),
      ),
    });

    expectNoTrustedDelivery(result);
  });

  it("does not run an agent for an unsigned DM that names an allowlisted open_id", async () => {
    const port = await reservePort();
    const result = await exerciseWebhook({
      port,
      cfg: baseFeishu(port, {
        dmPolicy: "allowlist",
        allowFrom: ["ou_allowlisted_user"],
      }),
      rawBody: JSON.stringify(
        messageEvent({
          openId: "ou_allowlisted_user",
          chatId: "oc_dm_placeholder",
          chatType: "p2p",
          text: "forged allowlisted dm",
          messageId: nextMessageId(),
        }),
      ),
    });

    expectNoTrustedDelivery(result);
  });

  it("does not run an agent for an unsigned group event that names an allowlisted chat_id", async () => {
    const port = await reservePort();
    const result = await exerciseWebhook({
      port,
      cfg: baseFeishu(port, {
        groupPolicy: "allowlist",
        groupAllowFrom: ["oc_allowlisted_chat"],
        requireMention: false,
      }),
      rawBody: JSON.stringify(
        messageEvent({
          openId: "ou_untrusted_speaker",
          chatId: "oc_allowlisted_chat",
          chatType: "group",
          text: "forged group message",
          messageId: nextMessageId(),
        }),
      ),
    });

    expectNoTrustedDelivery(result);
  });

  it("does not treat a verification token alone as webhook authentication", async () => {
    const port = await reservePort();
    const result = await exerciseWebhook({
      port,
      cfg: baseFeishu(port, {
        dmPolicy: "open",
        allowFrom: ["*"],
        verificationToken: VERIFICATION_TOKEN,
      }),
      rawBody: JSON.stringify(
        messageEvent({
          openId: "ou_untrusted_stranger",
          chatId: "oc_dm_placeholder",
          chatType: "p2p",
          text: "forged with token configured",
          messageId: nextMessageId(),
        }),
      ),
    });

    expectNoTrustedDelivery(result);
  });

  it("does not treat a blank encrypt key as configured", async () => {
    const port = await reservePort();
    const result = await exerciseWebhook({
      port,
      cfg: baseFeishu(port, {
        dmPolicy: "open",
        allowFrom: ["*"],
        encryptKey: "   ",
      }),
      rawBody: JSON.stringify(
        messageEvent({
          openId: "ou_untrusted_stranger",
          chatId: "oc_dm_placeholder",
          chatType: "p2p",
          text: "forged blank encrypt key",
          messageId: nextMessageId(),
        }),
      ),
    });

    expectNoTrustedDelivery(result);
  });

  it("does not authenticate an account whose encrypt key overrides a top-level key with blanks", async () => {
    const port = await reservePort();
    const result = await exerciseWebhook({
      port,
      accountId: "ops",
      cfg: {
        channels: {
          feishu: {
            enabled: true,
            appId: APP_ID,
            appSecret: APP_SECRET,
            domain: LOCAL_API,
            encryptKey: ENCRYPT_KEY,
            dmPolicy: "open",
            allowFrom: ["*"],
            accounts: {
              ops: {
                connectionMode: "webhook",
                webhookPath: WEBHOOK_PATH,
                webhookPort: port,
                encryptKey: " ",
              },
            },
          },
        },
      } as ClawdbotConfig,
      rawBody: JSON.stringify(
        messageEvent({
          openId: "ou_untrusted_stranger",
          chatId: "oc_dm_placeholder",
          chatType: "p2p",
          text: "forged account override",
          messageId: nextMessageId(),
        }),
      ),
    });

    expectNoTrustedDelivery(result);
  });

  it("does not run an agent when every enabled account is monitored without an account id", async () => {
    const port = await reservePort();
    const result = await exerciseWebhook({
      port,
      cfg: baseFeishu(port, { dmPolicy: "open", allowFrom: ["*"] }),
      rawBody: JSON.stringify(
        messageEvent({
          openId: "ou_untrusted_stranger",
          chatId: "oc_dm_placeholder",
          chatType: "p2p",
          text: "forged all accounts",
          messageId: nextMessageId(),
        }),
      ),
    });

    expectNoTrustedDelivery(result);
  });

  it("rejects an unsigned event when an encrypt key is configured", async () => {
    const port = await reservePort();
    const rawBody = JSON.stringify(
      messageEvent({
        openId: "ou_allowlisted_user",
        chatId: "oc_dm_placeholder",
        chatType: "p2p",
        text: "unsigned but key is set",
        messageId: nextMessageId(),
      }),
    );
    const result = await exerciseWebhook({
      port,
      cfg: baseFeishu(port, {
        dmPolicy: "allowlist",
        allowFrom: ["ou_allowlisted_user"],
        encryptKey: ENCRYPT_KEY,
        verificationToken: VERIFICATION_TOKEN,
      }),
      rawBody,
      headers: {
        "x-lark-request-timestamp": "1700000000",
        "x-lark-request-nonce": "nonce-placeholder",
        "x-lark-signature": "00",
      },
    });

    expect(result.listening, JSON.stringify(result)).toBe(true);
    expectNoTrustedDelivery(result);
  });

  it("runs the agent for a correctly signed event and keeps the claimed sender", async () => {
    const port = await reservePort();
    const rawBody = JSON.stringify(
      messageEvent({
        openId: "ou_allowlisted_user",
        chatId: "oc_dm_placeholder",
        chatType: "p2p",
        text: "signed hello",
        messageId: nextMessageId(),
      }),
    );
    const timestamp = "1700000000";
    const nonce = "nonce-placeholder";
    const result = await exerciseWebhook({
      port,
      cfg: baseFeishu(port, {
        dmPolicy: "allowlist",
        allowFrom: ["ou_allowlisted_user"],
        encryptKey: ENCRYPT_KEY,
      }),
      rawBody,
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signBody(rawBody, timestamp, nonce, ENCRYPT_KEY),
      },
      settleOnEffect: true,
    });

    expect(result.listening, JSON.stringify(result)).toBe(true);
    expect(result.dispatches, JSON.stringify(result)).toEqual([
      expect.objectContaining({
        senderId: "ou_allowlisted_user",
        bodyForAgent: "signed hello",
        chatType: "direct",
        originatingTo: "user:ou_allowlisted_user",
      }),
    ]);
    expect(result.systemEvents.some((text) => text.includes("signed hello"))).toBe(true);
  });

  it("binds webhook mode to loopback when no host is configured", async () => {
    const port = await reservePort();
    const result = await exerciseWebhook({
      port,
      cfg: baseFeishu(port, {
        dmPolicy: "allowlist",
        allowFrom: ["ou_allowlisted_user"],
        encryptKey: ENCRYPT_KEY,
      }),
      rawBody: JSON.stringify(
        messageEvent({
          openId: "ou_allowlisted_user",
          chatId: "oc_dm_placeholder",
          chatType: "p2p",
          text: "bind check",
          messageId: nextMessageId(),
        }),
      ),
      headers: {
        "x-lark-request-timestamp": "1700000000",
        "x-lark-request-nonce": "nonce-placeholder",
        "x-lark-signature": "00",
      },
    });

    expect(result.listening, JSON.stringify(result)).toBe(true);
    expect(result.listenAddresses.length, JSON.stringify(result)).toBeGreaterThan(0);
    expect(
      result.listenAddresses.every(isLoopbackAddress),
      JSON.stringify(result.listenAddresses),
    ).toBe(true);
  });
});
