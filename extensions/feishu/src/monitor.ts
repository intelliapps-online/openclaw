import * as crypto from "crypto";
import * as http from "http";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  type ClawdbotConfig,
  type RuntimeEnv,
  type HistoryEntry,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount, listEnabledFeishuAccounts } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent, type FeishuBotAddedEvent } from "./bot.js";
import { createFeishuWSClient, createEventDispatcher } from "./client.js";
import { probeFeishu } from "./probe.js";
import type { ResolvedFeishuAccount } from "./types.js";

export type MonitorFeishuOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
};

// Per-account WebSocket clients, HTTP servers, and bot info
const wsClients = new Map<string, Lark.WSClient>();
const httpServers = new Map<string, http.Server>();
const botOpenIds = new Map<string, string>();
const FEISHU_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const FEISHU_WEBHOOK_BODY_TIMEOUT_MS = 30_000;
const FEISHU_WEBHOOK_DEFAULT_HOST = "127.0.0.1";

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Feishu signs webhook deliveries as sha256(timestamp + nonce + encryptKey + rawBody).
 * The Lark SDK skips this check whenever its dispatcher has no encrypt key, so it is
 * enforced here, on the raw bytes, before anything reaches the dispatcher.
 */
function isFeishuWebhookSignatureValid(params: {
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  encryptKey: string;
}): boolean {
  const { headers, rawBody, encryptKey } = params;
  if (!encryptKey) {
    return false;
  }
  const timestamp = firstHeader(headers["x-lark-request-timestamp"]);
  const nonce = firstHeader(headers["x-lark-request-nonce"]);
  const signature = firstHeader(headers["x-lark-signature"]);
  if (!timestamp || !nonce || !signature) {
    return false;
  }
  const expected = Buffer.from(
    crypto
      .createHash("sha256")
      .update(timestamp + nonce + encryptKey + rawBody)
      .digest("hex"),
    "utf8",
  );
  const received = Buffer.from(signature, "utf8");
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

async function fetchBotOpenId(account: ResolvedFeishuAccount): Promise<string | undefined> {
  try {
    const result = await probeFeishu(account);
    return result.ok ? result.botOpenId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Register common event handlers on an EventDispatcher.
 * When fireAndForget is true (webhook mode), message handling is not awaited
 * to avoid blocking the HTTP response (Lark requires <3s response).
 */
function registerEventHandlers(
  eventDispatcher: Lark.EventDispatcher,
  context: {
    cfg: ClawdbotConfig;
    accountId: string;
    runtime?: RuntimeEnv;
    chatHistories: Map<string, HistoryEntry[]>;
    fireAndForget?: boolean;
  },
) {
  const { cfg, accountId, runtime, chatHistories, fireAndForget } = context;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  eventDispatcher.register({
    "im.message.receive_v1": async (data) => {
      try {
        const event = data as unknown as FeishuMessageEvent;
        const promise = handleFeishuMessage({
          cfg,
          event,
          botOpenId: botOpenIds.get(accountId),
          runtime,
          chatHistories,
          accountId,
        });
        if (fireAndForget) {
          promise.catch((err) => {
            error(`feishu[${accountId}]: error handling message: ${String(err)}`);
          });
        } else {
          await promise;
        }
      } catch (err) {
        error(`feishu[${accountId}]: error handling message: ${String(err)}`);
      }
    },
    "im.message.message_read_v1": async () => {
      // Ignore read receipts
    },
    "im.chat.member.bot.added_v1": async (data) => {
      try {
        const event = data as unknown as FeishuBotAddedEvent;
        log(`feishu[${accountId}]: bot added to chat ${event.chat_id}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot added event: ${String(err)}`);
      }
    },
    "im.chat.member.bot.deleted_v1": async (data) => {
      try {
        const event = data as unknown as { chat_id: string };
        log(`feishu[${accountId}]: bot removed from chat ${event.chat_id}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot removed event: ${String(err)}`);
      }
    },
  });
}

type MonitorAccountParams = {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

/**
 * Monitor a single Feishu account.
 */
async function monitorSingleAccount(params: MonitorAccountParams): Promise<void> {
  const { cfg, account, runtime, abortSignal } = params;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;

  const connectionMode = account.config.connectionMode ?? "websocket";
  // Without an encrypt key, webhook deliveries cannot be authenticated.
  const webhookEncryptKey = account.encryptKey;
  if (connectionMode === "webhook" && !webhookEncryptKey) {
    throw new Error(
      `feishu[${accountId}]: webhook mode requires encryptKey (Feishu event subscription Encrypt Key); refusing to start unauthenticated webhook`,
    );
  }

  // Fetch bot open_id
  const botOpenId = await fetchBotOpenId(account);
  botOpenIds.set(accountId, botOpenId ?? "");
  log(`feishu[${accountId}]: bot open_id resolved: ${botOpenId ?? "unknown"}`);

  const eventDispatcher = createEventDispatcher(account);
  const chatHistories = new Map<string, HistoryEntry[]>();

  registerEventHandlers(eventDispatcher, {
    cfg,
    accountId,
    runtime,
    chatHistories,
    fireAndForget: connectionMode === "webhook",
  });

  if (connectionMode === "webhook" && webhookEncryptKey) {
    return monitorWebhook({ params, accountId, eventDispatcher, encryptKey: webhookEncryptKey });
  }

  return monitorWebSocket({ params, accountId, eventDispatcher });
}

type ConnectionParams = {
  params: MonitorAccountParams;
  accountId: string;
  eventDispatcher: Lark.EventDispatcher;
};

async function monitorWebSocket({
  params,
  accountId,
  eventDispatcher,
}: ConnectionParams): Promise<void> {
  const { account, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  log(`feishu[${accountId}]: starting WebSocket connection...`);

  const wsClient = createFeishuWSClient(account);
  wsClients.set(accountId, wsClient);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      wsClients.delete(accountId);
      botOpenIds.delete(accountId);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping`);
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    try {
      wsClient.start({ eventDispatcher });
      log(`feishu[${accountId}]: WebSocket client started`);
    } catch (err) {
      cleanup();
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    }
  });
}

function respondText(res: http.ServerResponse, status: number, text: string): void {
  if (res.headersSent) {
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

function createWebhookRequestHandler(params: {
  path: string;
  encryptKey: string;
  eventDispatcher: Lark.EventDispatcher;
  accountId: string;
  runtime?: RuntimeEnv;
}): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const { path, encryptKey, eventDispatcher, accountId, runtime } = params;
  const log = runtime?.log ?? console.log;

  return async (req, res) => {
    if (req.url !== path) {
      respondText(res, 404, "Not Found");
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      respondText(res, 405, "Method Not Allowed");
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readRequestBodyWithLimit(req, {
        maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
        timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
      });
    } catch (err) {
      if (isRequestBodyLimitError(err)) {
        respondText(res, err.statusCode, requestBodyErrorToText(err.code));
        return;
      }
      throw err;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      respondText(res, 400, "Invalid JSON");
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      respondText(res, 400, "Invalid payload");
      return;
    }

    // Same shape Lark.adaptDefault builds: headers live on the prototype so they stay
    // out of the SDK's own JSON.stringify-based signature check.
    const data = Object.assign(Object.create({ headers: req.headers }) as object, payload);

    // URL verification only echoes the challenge back and never reaches event handlers.
    let isChallenge: boolean;
    let challenge: unknown;
    try {
      ({ isChallenge, challenge } = Lark.generateChallenge(data, { encryptKey }));
    } catch {
      respondText(res, 400, "Invalid payload");
      return;
    }
    if (isChallenge) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(challenge));
      return;
    }

    if (!isFeishuWebhookSignatureValid({ headers: req.headers, rawBody, encryptKey })) {
      log(`feishu[${accountId}]: rejected webhook request with invalid signature`);
      respondText(res, 401, "Invalid signature");
      return;
    }

    const value = await eventDispatcher.invoke(data);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(value));
  };
}

async function monitorWebhook({
  params,
  accountId,
  eventDispatcher,
  encryptKey,
}: ConnectionParams & { encryptKey: string }): Promise<void> {
  const { account, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const host = account.config.webhookHost?.trim() || FEISHU_WEBHOOK_DEFAULT_HOST;
  const port = account.config.webhookPort ?? 3000;
  const path = account.config.webhookPath ?? "/feishu/events";

  log(`feishu[${accountId}]: starting Webhook server on ${host}:${port}, path ${path}...`);

  const server = http.createServer();
  const webhookHandler = createWebhookRequestHandler({
    path,
    encryptKey,
    eventDispatcher,
    accountId,
    runtime,
  });
  server.on("request", (req, res) => {
    void webhookHandler(req, res).catch((err) => {
      error(`feishu[${accountId}]: webhook handler error: ${String(err)}`);
      respondText(res, 500, "Internal Server Error");
    });
  });
  httpServers.set(accountId, server);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.close();
      httpServers.delete(accountId);
      botOpenIds.delete(accountId);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping Webhook server`);
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    server.listen(port, host, () => {
      log(`feishu[${accountId}]: Webhook server listening on ${host}:${port}`);
    });

    server.on("error", (err) => {
      error(`feishu[${accountId}]: Webhook server error: ${err}`);
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    });
  });
}

/**
 * Main entry: start monitoring for all enabled accounts.
 */
export async function monitorFeishuProvider(opts: MonitorFeishuOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for Feishu monitor");
  }

  const log = opts.runtime?.log ?? console.log;

  // If accountId is specified, only monitor that account
  if (opts.accountId) {
    const account = resolveFeishuAccount({ cfg, accountId: opts.accountId });
    if (!account.enabled || !account.configured) {
      throw new Error(`Feishu account "${opts.accountId}" not configured or disabled`);
    }
    return monitorSingleAccount({
      cfg,
      account,
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
    });
  }

  // Otherwise, start all enabled accounts
  const accounts = listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("No enabled Feishu accounts configured");
  }

  log(
    `feishu: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`,
  );

  // Start all accounts in parallel
  await Promise.all(
    accounts.map((account) =>
      monitorSingleAccount({
        cfg,
        account,
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
      }),
    ),
  );
}

/**
 * Stop monitoring for a specific account or all accounts.
 */
export function stopFeishuMonitor(accountId?: string): void {
  if (accountId) {
    wsClients.delete(accountId);
    const server = httpServers.get(accountId);
    if (server) {
      server.close();
      httpServers.delete(accountId);
    }
    botOpenIds.delete(accountId);
  } else {
    wsClients.clear();
    for (const server of httpServers.values()) {
      server.close();
    }
    httpServers.clear();
    botOpenIds.clear();
  }
}
