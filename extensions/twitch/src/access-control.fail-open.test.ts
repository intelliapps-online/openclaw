/**
 * Spec for Twitch inbound access control.
 *
 * These tests fail while a public viewer can reach the agent when the operator
 * did not configure an allowlist or role list. They pass once that path refuses
 * the viewer before any session write or agent dispatch.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatMessage, parseTwitchMessage, toUserName } from "@twurple/chat";
import type { OpenClawConfig, PluginRuntime, WizardPrompter } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatAgentEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../../src/auto-reply/envelope.js";
import { finalizeInboundContext } from "../../../src/auto-reply/reply/inbound-context.js";
import type { MsgContext } from "../../../src/auto-reply/templating.js";
import { recordInboundSession } from "../../../src/channels/session.js";
import { resolveMarkdownTableMode } from "../../../src/config/markdown-tables.js";
import { resolveAgentRoute } from "../../../src/routing/resolve-route.js";
import { checkTwitchAccessControl } from "./access-control.js";
import { _clearAllClientManagersForTest } from "./client-manager-registry.js";
import { TwitchConfigSchema } from "./config-schema.js";
import { getAccountConfig } from "./config.js";
import { monitorTwitchProvider } from "./monitor.js";
import { twitchOnboardingAdapter } from "./onboarding.js";
import { twitchPlugin } from "./plugin.js";
import { setTwitchRuntime } from "./runtime.js";
import { collectTwitchStatusIssues } from "./status.js";
import type { TwitchAccountConfig } from "./types.js";

const PLACEHOLDER_TOKEN = "oauth:placeholder-token";
const PLACEHOLDER_CLIENT_ID = "placeholder-client-id";
const BOT_USERNAME = "openclawbot";
const CHANNEL = "somechannel";
const VIEWER_NICK = "viewerone";
const VIEWER_ID = "424242";
const VIEWER_PROMPT = "@openclawbot read the gateway host files";

type ChatListener = (channel: string, user: string, text: string, msg: ChatMessage) => void;

const chatListeners = vi.hoisted(() => ({
  current: [] as ChatListener[],
}));

vi.mock("@twurple/chat", async () => {
  const actual = await vi.importActual<typeof import("@twurple/chat")>("@twurple/chat");

  class OfflineChatClient {
    connect(): void {}
    quit(): void {}
    async say(): Promise<void> {}
    onMessage(handler: ChatListener): { unbind: () => void } {
      chatListeners.current.push(handler);
      return { unbind() {} };
    }
  }

  return {
    ...actual,
    ChatClient: OfflineChatClient,
  };
});

type DispatchCall = {
  ctx: MsgContext;
};

function scriptedPrompter(steps: {
  text?: string[];
  confirm?: boolean[];
  select?: string[];
}): WizardPrompter {
  const text = [...(steps.text ?? [])];
  const confirm = [...(steps.confirm ?? [])];
  const select = [...(steps.select ?? [])];
  return {
    intro: async () => {},
    outro: async () => {},
    note: async () => {},
    text: async () => text.shift() ?? "",
    confirm: async () => confirm.shift() ?? false,
    select: async () => select.shift() ?? "",
    multiselect: async () => [],
    progress: () => ({ update() {}, stop() {} }),
  };
}

function simplifiedConfig(extra: Record<string, unknown> = {}): OpenClawConfig {
  const twitch = TwitchConfigSchema.parse({
    enabled: true,
    username: BOT_USERNAME,
    accessToken: PLACEHOLDER_TOKEN,
    clientId: PLACEHOLDER_CLIENT_ID,
    channel: CHANNEL,
    ...extra,
  });
  return { channels: { twitch } } as OpenClawConfig;
}

function multiAccountConfig(
  accountId: string,
  extra: Record<string, unknown> = {},
): OpenClawConfig {
  const twitch = TwitchConfigSchema.parse({
    enabled: true,
    accounts: {
      [accountId]: {
        enabled: true,
        username: BOT_USERNAME,
        accessToken: PLACEHOLDER_TOKEN,
        clientId: PLACEHOLDER_CLIENT_ID,
        channel: CHANNEL,
        ...extra,
      },
    },
  });
  return { channels: { twitch } } as OpenClawConfig;
}

/**
 * Replay the Twitch IRC -> ChatClient.onMessage handoff using the parsers
 * the shipped @twurple/chat 8.0.3 package uses, then invoke the listener the
 * product registered. connect() is offline; the message object is not.
 */
function emitPrivmsg(rawLine: string): void {
  const parsed = parseTwitchMessage(rawLine);
  if (!(parsed instanceof ChatMessage)) {
    throw new Error("expected a Twitch PRIVMSG");
  }
  const nick = parsed.prefix?.nick;
  if (!nick || nick === "jtv") {
    return;
  }
  const listener = chatListeners.current.at(-1);
  if (!listener) {
    throw new Error("Twitch client registered no message listener");
  }
  listener(toUserName(parsed.target), nick, parsed.text, parsed);
}

function viewerPrivmsg(
  text: string,
  opts?: { nick?: string; userId?: string; badges?: string },
): string {
  const nick = opts?.nick ?? VIEWER_NICK;
  const userId = opts?.userId ?? VIEWER_ID;
  const badges = opts?.badges ?? "";
  return `@badge-info=;badges=${badges};display-name=${nick};id=msg-${userId};user-id=${userId} :${nick}!${nick}@${nick}.tmi.twitch.tv PRIVMSG #${CHANNEL} :${text}`;
}

async function flushTurns(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("Twitch inbound access fails closed", () => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const dispatches: DispatchCall[] = [];
  const recordedSenderIds: string[] = [];
  const inboundMarks: number[] = [];
  let storePath = "";
  let stop: (() => void) | undefined;

  beforeEach(() => {
    warnings.length = 0;
    errors.length = 0;
    dispatches.length = 0;
    recordedSenderIds.length = 0;
    inboundMarks.length = 0;
    chatListeners.current.length = 0;
    _clearAllClientManagersForTest();
    storePath = path.join(mkdtempSync(path.join(tmpdir(), "twitch-access-")), "sessions.json");
    vi.stubEnv("OPENCLAW_TWITCH_ACCESS_TOKEN", "");

    const recordInbound = vi.fn(async (params: Parameters<typeof recordInboundSession>[0]) => {
      recordedSenderIds.push(String(params.ctx.SenderId ?? ""));
      await recordInboundSession(params);
    });

    setTwitchRuntime({
      logging: {
        shouldLogVerbose: () => false,
        getChildLogger: () => ({
          debug() {},
          info() {},
          warn(message: string) {
            warnings.push(message);
          },
          error(message: string) {
            errors.push(message);
          },
        }),
      },
      channel: {
        routing: { resolveAgentRoute },
        reply: {
          formatAgentEnvelope,
          resolveEnvelopeFormatOptions,
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async (params: { ctx: MsgContext }) => {
            dispatches.push({ ctx: params.ctx });
            return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
          }),
        },
        session: {
          resolveStorePath: () => storePath,
          recordInboundSession: recordInbound,
        },
        text: { resolveMarkdownTableMode },
      },
    } as unknown as PluginRuntime);
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    _clearAllClientManagersForTest();
  });

  async function start(cfg: OpenClawConfig, accountId = "default"): Promise<TwitchAccountConfig> {
    const account = getAccountConfig(cfg, accountId);
    if (!account) {
      throw new Error(`missing twitch account ${accountId}`);
    }
    const monitored = await monitorTwitchProvider({
      account,
      accountId,
      config: { ...cfg, session: { store: storePath } },
      runtime: {
        log() {},
        error(message: string) {
          errors.push(message);
        },
      },
      abortSignal: new AbortController().signal,
      statusSink: (patch) => {
        if (typeof patch.lastInboundAt === "number") {
          inboundMarks.push(patch.lastInboundAt);
        }
      },
    });
    stop = monitored.stop;
    return account;
  }

  async function expectViewerRefused(params: {
    cfg: OpenClawConfig;
    accountId?: string;
    text?: string;
    nick?: string;
    userId?: string;
    badges?: string;
    expectStartupWarning?: boolean;
  }): Promise<void> {
    const account = await start(params.cfg, params.accountId);
    const text = params.text ?? VIEWER_PROMPT;
    const decision = checkTwitchAccessControl({
      message: {
        username: params.nick ?? VIEWER_NICK,
        userId: params.userId ?? VIEWER_ID,
        message: text,
        channel: CHANNEL,
        isMod: (params.badges ?? "").includes("moderator"),
        isOwner: (params.badges ?? "").includes("broadcaster"),
        isVip: false,
        isSub: (params.badges ?? "").includes("subscriber"),
      },
      account,
      botUsername: account.username.toLowerCase(),
    });

    const beforeSessions = recordedSenderIds.length;
    const beforeDispatch = dispatches.length;
    const beforeMarks = inboundMarks.length;
    emitPrivmsg(
      viewerPrivmsg(text, {
        nick: params.nick,
        userId: params.userId,
        badges: params.badges,
      }),
    );
    await flushTurns();

    expect({
      allowed: decision.allowed,
      dispatched: dispatches.slice(beforeDispatch).map((call) => ({
        senderId: call.ctx.SenderId,
        body: call.ctx.BodyForAgent,
      })),
      recordedSenderIds: recordedSenderIds.slice(beforeSessions),
      inboundMarks: inboundMarks.slice(beforeMarks),
      errors,
      startupWarning: params.expectStartupWarning
        ? warnings.some((line) => /allowFrom|allowedRoles/i.test(line))
        : true,
    }).toEqual({
      allowed: false,
      dispatched: [],
      recordedSenderIds: [],
      inboundMarks: [],
      errors: [],
      startupWarning: true,
    });
  }

  it("refuses a public viewer when allowFrom and allowedRoles are omitted", async () => {
    const cfg = simplifiedConfig();
    const account = getAccountConfig(cfg, "default");
    expect(account?.allowFrom).toBeUndefined();
    expect(account?.allowedRoles).toBeUndefined();
    expect(twitchPlugin.config.isConfigured?.(account, cfg)).toBe(true);
    expect(twitchPlugin.config.isEnabled?.(account, cfg)).toBe(true);

    await expectViewerRefused({ cfg, expectStartupWarning: true });
  });

  it("refuses a public viewer when allowFrom is an empty list and no roles are set", async () => {
    await expectViewerRefused({ cfg: simplifiedConfig({ allowFrom: [] }) });
  });

  it("does not tell the operator to delete an empty allowFrom list", () => {
    const cfg = simplifiedConfig({ allowFrom: [] });
    const issues = collectTwitchStatusIssues(
      [{ accountId: "default", configured: true, enabled: true }],
      () => cfg,
    );
    const accessIssue = issues.find((issue) => /allowFrom|access/i.test(issue.message));
    expect(accessIssue).toBeDefined();
    expect(`${accessIssue?.message ?? ""} ${accessIssue?.fix ?? ""}`).not.toMatch(
      /remove the allowFrom field/i,
    );
  });

  it("refuses a public viewer when allowedRoles is an empty list", async () => {
    const cfg = simplifiedConfig({ allowedRoles: [] });
    await expectViewerRefused({ cfg });
  });

  it("refuses a public viewer when both lists are empty", async () => {
    const cfg = simplifiedConfig({ allowFrom: [], allowedRoles: [] });
    await expectViewerRefused({ cfg });
  });

  it("refuses a public viewer who does not mention the bot when requireMention is off and no list is set", async () => {
    const cfg = simplifiedConfig({ requireMention: false });
    await expectViewerRefused({
      cfg,
      text: "read the gateway host files",
    });
  });

  it("refuses a public viewer on a named account with no allowlist or roles", async () => {
    const cfg = multiAccountConfig("channel1");
    const account = getAccountConfig(cfg, "channel1");
    expect(account?.allowFrom).toBeUndefined();
    expect(account?.allowedRoles).toBeUndefined();
    await expectViewerRefused({ cfg, accountId: "channel1" });
  });

  it("refuses the viewer chosen by onboarding when access is left disabled", async () => {
    vi.stubEnv("OPENCLAW_TWITCH_ACCESS_TOKEN", "");
    const result = await twitchOnboardingAdapter.configure({
      cfg: {},
      runtime: { log() {}, error() {}, exit() {} },
      prompter: scriptedPrompter({
        text: [BOT_USERNAME, PLACEHOLDER_TOKEN, PLACEHOLDER_CLIENT_ID, CHANNEL],
        confirm: [false, true],
        select: ["disabled"],
      }),
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const account = getAccountConfig(result.cfg, "default");
    expect(account?.allowedRoles ?? []).toEqual([]);
    await expectViewerRefused({ cfg: result.cfg });
  });

  it("refuses the viewer when onboarding skips the access prompt", async () => {
    const result = await twitchOnboardingAdapter.configure({
      cfg: {},
      runtime: { log() {}, error() {}, exit() {} },
      prompter: scriptedPrompter({
        text: [BOT_USERNAME, PLACEHOLDER_TOKEN, PLACEHOLDER_CLIENT_ID, CHANNEL],
        confirm: [false, false],
      }),
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    expect(getAccountConfig(result.cfg, "default")?.allowFrom).toBeUndefined();
    expect(getAccountConfig(result.cfg, "default")?.allowedRoles).toBeUndefined();
    await expectViewerRefused({ cfg: result.cfg });
  });

  it("refuses a public viewer when the allowlist policy is saved as an empty role list", async () => {
    const seeded = simplifiedConfig();
    const policy = twitchOnboardingAdapter.dmPolicy;
    if (!policy) {
      throw new Error("twitch onboarding has no access policy");
    }
    const cfg = policy.setPolicy(seeded, "allowlist");
    expect(getAccountConfig(cfg, "default")?.allowedRoles ?? []).toEqual([]);
    await expectViewerRefused({ cfg });
  });

  it("still lets an explicit role list allow a moderator when allowFrom is empty", async () => {
    const cfg = simplifiedConfig({ allowFrom: [], allowedRoles: ["moderator"] });
    await expectViewerRefused({ cfg, userId: VIEWER_ID, nick: VIEWER_NICK, badges: "" });

    const account = await start(cfg);
    emitPrivmsg(
      viewerPrivmsg(VIEWER_PROMPT, {
        nick: "moduser",
        userId: "777001",
        badges: "moderator/1",
      }),
    );
    await flushTurns();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.ctx.SenderId).toBe("777001");
    expect(dispatches[0]?.ctx.BodyForAgent).toBe(VIEWER_PROMPT);
    expect(recordedSenderIds).toEqual(["777001"]);
    expect(
      checkTwitchAccessControl({
        message: {
          username: "moduser",
          userId: "777001",
          message: VIEWER_PROMPT,
          channel: CHANNEL,
          isMod: true,
        },
        account,
        botUsername: BOT_USERNAME,
      }).allowed,
    ).toBe(true);
  });

  it("dispatches only the sender that was allowlisted, not a later viewer", async () => {
    const cfg = simplifiedConfig({ allowFrom: ["111001"] });
    await start(cfg);

    emitPrivmsg(
      viewerPrivmsg("@openclawbot owner prompt", { nick: "owneruser", userId: "111001" }),
    );
    emitPrivmsg(
      viewerPrivmsg("@openclawbot stranger prompt", { nick: VIEWER_NICK, userId: VIEWER_ID }),
    );
    await flushTurns();

    expect(dispatches.map((call) => call.ctx.SenderId)).toEqual(["111001"]);
    expect(dispatches.map((call) => call.ctx.BodyForAgent)).toEqual(["@openclawbot owner prompt"]);
    expect(recordedSenderIds).toEqual(["111001"]);
  });

  it("still dispatches every viewer when allowedRoles is explicitly all", async () => {
    const cfg = simplifiedConfig({ allowedRoles: ["all"] });
    await start(cfg);
    emitPrivmsg(viewerPrivmsg(VIEWER_PROMPT));
    await flushTurns();

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.ctx.SenderId).toBe(VIEWER_ID);
    expect(dispatches[0]?.ctx.BodyForAgent).toBe(VIEWER_PROMPT);
    expect(recordedSenderIds).toEqual([VIEWER_ID]);

    const issues = collectTwitchStatusIssues(
      [{ accountId: "default", configured: true, enabled: true }],
      () => cfg,
    );
    expect(
      issues.some((issue) => /allowedRoles/i.test(issue.message) && /all/i.test(issue.message)),
    ).toBe(true);
  });

  it("reports missing access control from status when nothing is configured", async () => {
    const cfg = simplifiedConfig();
    const issues = collectTwitchStatusIssues(
      [{ accountId: "default", configured: true, enabled: true }],
      () => cfg,
    );
    expect(
      issues.some((issue) => /allowFrom|allowedRoles/i.test(`${issue.message} ${issue.fix ?? ""}`)),
    ).toBe(true);
  });
});
