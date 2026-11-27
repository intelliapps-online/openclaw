/**
 * Security spec for Teams sender allowlists.
 *
 * These tests are expected to fail until runtime authorization ignores display
 * names and uses only immutable ids (AAD object id / from.aadObjectId).
 * A display name in allowFrom, groupAllowFrom, or toolsBySender must not admit
 * a different object id, including after startup has also stored the resolved id.
 */
import { createRequire } from "node:module";
import type { Activity } from "@microsoft/agents-activity";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";

const requireFromHosting = createRequire(
  createRequire(import.meta.url).resolve("@microsoft/agents-hosting/package.json"),
);
// CloudAdapter.process parses the webhook body with this Activity class
// (@microsoft/agents-activity, the version @microsoft/agents-hosting depends on).
const { Activity: ConnectorActivity } = requireFromHosting("@microsoft/agents-activity") as {
  Activity: typeof Activity;
};
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHumanDelayConfig } from "../../../../src/agents/identity.js";
import {
  isToolAllowedByPolicyName,
  resolveGroupToolPolicy,
} from "../../../../src/agents/pi-tools.policy.js";
import { resolveChunkMode } from "../../../../src/auto-reply/chunk.js";
import { resolveCommandAuthorization } from "../../../../src/auto-reply/command-auth.js";
import { hasControlCommand } from "../../../../src/auto-reply/command-detection.js";
import {
  formatAgentEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../../../src/auto-reply/envelope.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../../../src/auto-reply/inbound-debounce.js";
import { finalizeInboundContext } from "../../../../src/auto-reply/reply/inbound-context.js";
import { mergeAllowlist } from "../../../../src/channels/allowlists/resolve-utils.js";
import { resolveMarkdownTableMode } from "../../../../src/config/markdown-tables.js";
import { createEmptyPluginRegistry } from "../../../../src/plugins/registry.js";
import { setActivePluginRegistry } from "../../../../src/plugins/runtime.js";
import { resolveAgentRoute } from "../../../../src/routing/resolve-route.js";
import { createTestRegistry } from "../../../../src/test-utils/channel-plugins.js";
import { msteamsPlugin } from "../channel.js";
import { createMSTeamsConversationStoreMemory } from "../conversation-store-memory.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import { setMSTeamsRuntime } from "../runtime.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";

const OPERATOR_AAD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ATTACKER_AAD = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DISPLAY_NAME = "Jane Doe";
const BOT_ID = "28:bot";

type DeliveredTurn = {
  senderId?: string;
  senderName?: string;
  commandAuthorized?: boolean;
  body?: string;
  isAuthorizedSender?: boolean;
};

const delivered: DeliveredTurn[] = [];

function allowlistWithResolvedId(): string[] {
  // monitorMSTeamsProvider keeps the typed name and appends a resolved object id.
  return mergeAllowlist({
    existing: [`  ${DISPLAY_NAME}  `],
    additions: [OPERATOR_AAD],
  });
}

function baseConfig(msteams: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      msteams,
    },
  } as OpenClawConfig;
}

function connectorActivity(params: {
  text: string;
  conversationType: "personal" | "groupChat" | "channel";
  conversationId: string;
  senderId: string;
  aadObjectId: string;
  name: string;
  mentionBot?: boolean;
}) {
  // Same parse CloudAdapter.process applies to the webhook body: the connector
  // payload's from.name and from.aadObjectId are copied through unchanged.
  const payload = {
    type: "message",
    id: `activity-${params.conversationId}-${params.aadObjectId}-${params.text}`,
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/teams/",
    text: params.text,
    timestamp: "2026-01-15T12:00:00.000Z",
    from: {
      id: params.senderId,
      name: params.name,
      aadObjectId: params.aadObjectId,
      role: "user",
    },
    recipient: { id: BOT_ID, name: "OpenClaw" },
    conversation: {
      id: params.conversationId,
      conversationType: params.conversationType,
      tenantId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    },
    entities: params.mentionBot
      ? [
          {
            type: "mention",
            text: "<at>OpenClaw</at>",
            mentioned: { id: BOT_ID, name: "OpenClaw" },
          },
        ]
      : undefined,
  };
  return ConnectorActivity.fromObject(payload);
}

function installRuntime(cfg: OpenClawConfig) {
  const runtime = {
    version: "test",
    logging: {
      shouldLogVerbose: () => false,
    },
    system: {
      enqueueSystemEvent: vi.fn(),
    },
    channel: {
      text: {
        hasControlCommand,
        resolveChunkMode,
        resolveMarkdownTableMode,
      },
      debounce: {
        createInboundDebouncer,
        resolveInboundDebounceMs,
      },
      routing: {
        resolveAgentRoute,
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "PAIR", created: true })),
      },
      reply: {
        finalizeInboundContext,
        formatAgentEnvelope,
        resolveEnvelopeFormatOptions,
        resolveHumanDelayConfig,
        createReplyDispatcherWithTyping: vi.fn(() => ({
          dispatcher: {
            getQueuedCounts: () => ({ final: 0, block: 0, tool: 0 }),
            sendFinalReply: vi.fn(),
          },
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        })),
        dispatchReplyFromConfig: vi.fn(async (params: { ctx: Record<string, unknown> }) => {
          const ctx = params.ctx;
          const commandAuthorized = ctx.CommandAuthorized === true;
          const auth = resolveCommandAuthorization({
            ctx: ctx as never,
            cfg,
            commandAuthorized,
          });
          delivered.push({
            senderId: typeof ctx.SenderId === "string" ? ctx.SenderId : undefined,
            senderName: typeof ctx.SenderName === "string" ? ctx.SenderName : undefined,
            commandAuthorized,
            body: typeof ctx.BodyForAgent === "string" ? ctx.BodyForAgent : undefined,
            isAuthorizedSender: auth.isAuthorizedSender,
          });
          return { queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } };
        }),
      },
      session: {
        resolveStorePath: () => "/tmp/openclaw-msteams-allowlist-test-sessions.json",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: vi.fn(async () => {}),
      },
    },
  } as unknown as PluginRuntime;
  setMSTeamsRuntime(runtime);
  return runtime;
}

function handlerFor(cfg: OpenClawConfig) {
  installRuntime(cfg);
  const conversationStore = createMSTeamsConversationStoreMemory();
  const deps = {
    cfg,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    appId: "app-id",
    adapter: {},
    tokenProvider: { getAccessToken: vi.fn(async () => "token") },
    textLimit: 4000,
    mediaMaxBytes: 1024,
    conversationStore,
    pollStore: {
      createPoll: vi.fn(),
      getPoll: vi.fn(),
      recordVote: vi.fn(),
    },
    log: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } satisfies MSTeamsMessageHandlerDeps;
  return { handle: createMSTeamsMessageHandler(deps), conversationStore };
}

async function deliver(params: {
  cfg: OpenClawConfig;
  text: string;
  conversationType: "personal" | "groupChat" | "channel";
  conversationId: string;
  senderId: string;
  aadObjectId: string;
  name: string;
  mentionBot?: boolean;
}) {
  const activity = connectorActivity(params);
  expect(activity.from?.aadObjectId).toBe(params.aadObjectId);
  expect(activity.from?.name).toBe(params.name);
  const { handle, conversationStore } = handlerFor(params.cfg);
  await handle({
    activity,
    sendActivity: vi.fn(async () => ({})),
    sendActivities: vi.fn(async () => ({})),
  });
  return { conversationStore };
}

function turnsFor(aadObjectId: string): DeliveredTurn[] {
  return delivered.filter((turn) => turn.senderId === aadObjectId);
}

describe("msteams display-name allowlist bypass", () => {
  beforeEach(() => {
    delivered.length = 0;
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "msteams", plugin: msteamsPlugin, source: "test" }]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("does not admit a DM from a different object id that shares an allowlisted display name", async () => {
    const allowFrom = allowlistWithResolvedId();
    expect(allowFrom.map((entry) => entry.toLowerCase())).toContain(DISPLAY_NAME.toLowerCase());
    expect(allowFrom).toContain(OPERATOR_AAD);
    const cfg = baseConfig({
      enabled: true,
      dmPolicy: "pairing",
      allowFrom,
    });

    await deliver({
      cfg,
      text: "hello from the operator",
      conversationType: "personal",
      conversationId: "dm-operator",
      senderId: "29:operator",
      aadObjectId: OPERATOR_AAD,
      name: "Renamed Operator",
    });
    const attackerDelivery = await deliver({
      cfg,
      text: "hello from the other jane",
      conversationType: "personal",
      conversationId: "dm-attacker",
      senderId: "29:attacker",
      aadObjectId: ATTACKER_AAD,
      name: "jane doe",
    });

    const operator = turnsFor(OPERATOR_AAD);
    const attacker = turnsFor(ATTACKER_AAD);
    expect(operator).toHaveLength(1);
    expect(operator[0]?.senderId).toBe(OPERATOR_AAD);
    expect(await attackerDelivery.conversationStore.get("dm-attacker")).toBeNull();
    expect(attacker).toEqual([]);
  });

  it("does not admit a group or channel sender that only matches an allowlisted display name", async () => {
    const allowFrom = allowlistWithResolvedId();
    const cfg = baseConfig({
      enabled: true,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom,
    });

    const outcomes: Array<{
      conversationType: string;
      operatorTurns: number;
      attackerTurns: number;
      attackerStored: boolean;
    }> = [];
    for (const conversationType of ["groupChat", "channel"] as const) {
      delivered.length = 0;
      const conversationId = `19:${conversationType}-attacker@thread.v2`;
      await deliver({
        cfg,
        text: `hello operator in ${conversationType}`,
        conversationType,
        conversationId: `19:${conversationType}-operator@thread.v2`,
        senderId: "29:operator",
        aadObjectId: OPERATOR_AAD,
        name: "Renamed Operator",
        mentionBot: true,
      });
      const attackerDelivery = await deliver({
        cfg,
        text: `hello attacker in ${conversationType}`,
        conversationType,
        conversationId,
        senderId: "29:attacker",
        aadObjectId: ATTACKER_AAD,
        name: DISPLAY_NAME,
        mentionBot: true,
      });
      outcomes.push({
        conversationType,
        operatorTurns: turnsFor(OPERATOR_AAD).length,
        attackerTurns: turnsFor(ATTACKER_AAD).length,
        attackerStored: (await attackerDelivery.conversationStore.get(conversationId)) != null,
      });
    }

    expect(outcomes).toEqual([
      {
        conversationType: "groupChat",
        operatorTurns: 1,
        attackerTurns: 0,
        attackerStored: false,
      },
      {
        conversationType: "channel",
        operatorTurns: 1,
        attackerTurns: 0,
        attackerStored: false,
      },
    ]);
  });

  it("does not authorize control commands for a display-name collision when DMs are open", async () => {
    const cfg = baseConfig({
      enabled: true,
      dmPolicy: "open",
      allowFrom: [DISPLAY_NAME, OPERATOR_AAD],
    });

    await deliver({
      cfg,
      text: "/status",
      conversationType: "personal",
      conversationId: "dm-operator-cmd",
      senderId: "29:operator",
      aadObjectId: OPERATOR_AAD,
      name: "Renamed Operator",
    });
    await deliver({
      cfg,
      text: "/status",
      conversationType: "personal",
      conversationId: "dm-attacker-cmd",
      senderId: "29:attacker",
      aadObjectId: ATTACKER_AAD,
      name: DISPLAY_NAME,
    });

    const operator = turnsFor(OPERATOR_AAD);
    expect(operator).toHaveLength(1);
    expect(operator[0]?.commandAuthorized).toBe(true);
    expect(operator[0]?.isAuthorizedSender).toBe(true);
    expect(operator[0]?.senderId).toBe(OPERATOR_AAD);
    expect(turnsFor(ATTACKER_AAD)).toEqual([]);
  });

  it("does not authorize group control commands for a display-name collision when groups are open", async () => {
    const cfg = baseConfig({
      enabled: true,
      dmPolicy: "pairing",
      groupPolicy: "open",
      allowFrom: [OPERATOR_AAD],
      groupAllowFrom: [DISPLAY_NAME, OPERATOR_AAD],
      requireMention: true,
    });

    await deliver({
      cfg,
      text: "/status",
      conversationType: "groupChat",
      conversationId: "19:open-group@thread.v2",
      senderId: "29:operator",
      aadObjectId: OPERATOR_AAD,
      name: "Renamed Operator",
      mentionBot: true,
    });
    await deliver({
      cfg,
      text: "/status",
      conversationType: "groupChat",
      conversationId: "19:open-group@thread.v2",
      senderId: "29:attacker",
      aadObjectId: ATTACKER_AAD,
      name: DISPLAY_NAME,
      mentionBot: true,
    });

    const operator = turnsFor(OPERATOR_AAD);
    expect(operator).toHaveLength(1);
    expect(operator[0]?.commandAuthorized).toBe(true);
    expect(operator[0]?.isAuthorizedSender).toBe(true);
    const attacker = turnsFor(ATTACKER_AAD);
    expect(attacker).toEqual([]);
  });

  it("does not grant toolsBySender host tools to a different object id with the same display name", () => {
    const conversationId = "19:tools@thread.v2";
    const cfg = baseConfig({
      enabled: true,
      teams: {
        "team-1": {
          channels: {
            [conversationId]: {
              tools: { deny: ["exec", "write", "edit", "apply_patch"] },
              toolsBySender: {
                [DISPLAY_NAME]: { allow: ["exec", "write", "edit", "apply_patch", "read"] },
                [OPERATOR_AAD]: { allow: ["exec", "write", "edit", "apply_patch", "read"] },
              },
            },
          },
        },
      },
    });

    const operatorPolicy = resolveGroupToolPolicy({
      config: cfg,
      messageProvider: "msteams",
      groupId: conversationId,
      groupSpace: "team-1",
      senderId: OPERATOR_AAD,
      senderName: "Renamed Operator",
    });
    const attackerPolicy = resolveGroupToolPolicy({
      config: cfg,
      messageProvider: "msteams",
      groupId: conversationId,
      groupSpace: "team-1",
      senderId: ATTACKER_AAD,
      senderName: DISPLAY_NAME,
    });

    expect(isToolAllowedByPolicyName("exec", operatorPolicy)).toBe(true);
    expect(isToolAllowedByPolicyName("exec", attackerPolicy)).toBe(false);
    expect(isToolAllowedByPolicyName("write", attackerPolicy)).toBe(false);
  });
});
