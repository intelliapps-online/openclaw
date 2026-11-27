import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAllowlistResolutionSummary,
  mergeAllowlist,
  patchAllowlistUsersInConfigEntries,
} from "../../channels/allowlists/resolve-utils.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { ResolvedSlackAccount } from "../accounts.js";
import { resolveSlackUserAllowlist } from "../resolve-users.js";
import type { SlackMessageEvent } from "../types.js";
import { createSlackMonitorContext, type SlackMonitorContext } from "./context.js";
import { prepareSlackMessage } from "./message-handler/prepare.js";
import { registerSlackMonitorSlashCommands } from "./slash.js";

const dispatchReplyWithDispatcher = vi.hoisted(() =>
  vi.fn(async () => ({ counts: { final: 1, tool: 0, block: 0 } })),
);

vi.mock("../../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithDispatcher,
}));

/**
 * Channel user gates and command authorization must follow Slack user ids.
 * Display names, full names, usernames, and slugs are mutable and not unique,
 * so a profile field must not satisfy an allowlist entry on its own.
 * These assertions fail while that comparison still authorizes the sender.
 */

const OWNER_ID = "U0OWNER001";
const ATTACKER_ID = "U0ATTACK01";
const CHANNEL_ID = "C0OPS00001";
const GROUP_ID = "G0PRIV0001";
const MPIM_ID = "G0MPIM0001";
const DM_ID = "D0DM000001";
const BOT_ID = "B0BOT00001";

type ProfileFields = {
  display_name?: string;
  real_name?: string;
  name?: string;
};

type ChannelUserConfig = Record<
  string,
  { allow?: boolean; requireMention?: boolean; users?: string[] }
>;

const startupDirectory = [
  {
    id: OWNER_ID,
    name: "alice",
    deleted: false,
    is_bot: false,
    is_app_user: false,
    real_name: "Alice Example",
    profile: {
      display_name: "Alice Smith",
      real_name: "Alice Example",
    },
  },
  {
    id: ATTACKER_ID,
    name: "mallory",
    deleted: false,
    is_bot: false,
    is_app_user: false,
    real_name: "Mallory Example",
    profile: {
      display_name: "Mallory",
      real_name: "Mallory Example",
    },
  },
];

function directoryClient(): WebClient {
  return {
    users: {
      list: async () => ({
        ok: true,
        members: startupDirectory,
        response_metadata: { next_cursor: "" },
      }),
    },
  } as unknown as WebClient;
}

async function resolveConfiguredAllowFrom(entries: string[]): Promise<string[]> {
  const allowEntries = entries.filter((entry) => entry.trim() && entry.trim() !== "*");
  if (allowEntries.length === 0) {
    return entries;
  }
  const resolvedUsers = await resolveSlackUserAllowlist({
    token: "test-bot-token",
    entries: allowEntries,
    client: directoryClient(),
  });
  const { additions } = buildAllowlistResolutionSummary(resolvedUsers);
  return mergeAllowlist({ existing: entries, additions });
}

async function resolveConfiguredChannelUsers(
  channels: ChannelUserConfig,
): Promise<ChannelUserConfig> {
  const resolvedUsers = await resolveSlackUserAllowlist({
    token: "test-bot-token",
    entries: Object.values(channels).flatMap((entry) => entry.users ?? []),
    client: directoryClient(),
  });
  const { resolvedMap } = buildAllowlistResolutionSummary(resolvedUsers);
  return patchAllowlistUsersInConfigEntries({
    entries: channels,
    resolvedMap,
  });
}

describe("slack allowlists ignore mutable profile names", () => {
  let fixtureRoot = "";
  let previousStateDir: string | undefined;
  let profiles: Record<string, ProfileFields> = {};

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-allowlist-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(fixtureRoot, "state");
    fs.mkdirSync(process.env.OPENCLAW_STATE_DIR, { recursive: true });
  });

  afterAll(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    profiles = {};
    dispatchReplyWithDispatcher.mockClear();
  });

  function liveClient() {
    return {
      users: {
        info: async ({ user }: { user: string }) => {
          const profile = profiles[user] ?? {};
          return {
            ok: true,
            user: {
              id: user,
              name: profile.name,
              real_name: profile.real_name,
              profile: {
                display_name: profile.display_name,
                real_name: profile.real_name,
              },
            },
          };
        },
      },
      conversations: {
        info: async ({ channel }: { channel: string }) => {
          if (channel.startsWith("D")) {
            return { ok: true, channel: { id: channel, is_im: true } };
          }
          if (channel === MPIM_ID) {
            return { ok: true, channel: { id: channel, name: "group-dm", is_mpim: true } };
          }
          if (channel.startsWith("G")) {
            return { ok: true, channel: { id: channel, name: "private", is_group: true } };
          }
          return { ok: true, channel: { id: channel, name: "ops", is_channel: true } };
        },
      },
      chat: {
        postEphemeral: async () => ({ ok: true }),
      },
    };
  }

  function storePath(name: string) {
    const dir = path.join(fixtureRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "sessions.json");
  }

  function createContext(params: {
    name: string;
    allowFrom?: string[];
    channels?: ChannelUserConfig;
    dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
    groupDmEnabled?: boolean;
  }): SlackMonitorContext {
    const cfg = {
      session: { store: storePath(params.name) },
      commands: { native: false },
      channels: { slack: { enabled: true } },
    } as OpenClawConfig;
    return createSlackMonitorContext({
      cfg,
      accountId: "default",
      botToken: "test-bot-token",
      app: { client: liveClient() } as App,
      runtime: { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv,
      botUserId: BOT_ID,
      teamId: "T0TEAM0001",
      apiAppId: "A0APP00001",
      historyLimit: 0,
      sessionScope: "per-sender",
      mainKey: "main",
      dmEnabled: true,
      dmPolicy: params.dmPolicy ?? "allowlist",
      allowFrom: params.allowFrom ?? [],
      groupDmEnabled: params.groupDmEnabled ?? false,
      groupDmChannels: [],
      defaultRequireMention: true,
      channelsConfig: params.channels,
      groupPolicy: "allowlist",
      useAccessGroups: true,
      reactionMode: "off",
      reactionAllowlist: [],
      replyToMode: "off",
      threadHistoryScope: "thread",
      threadInheritParent: false,
      slashCommand: {
        enabled: true,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      textLimit: 4000,
      ackReactionScope: "off",
      mediaMaxBytes: 1024,
      removeAckAfterReply: false,
    });
  }

  function message(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
    return {
      type: "message",
      channel: CHANNEL_ID,
      channel_type: "channel",
      user: ATTACKER_ID,
      text: "hello",
      ts: "1700000000.000100",
      ...overrides,
    } as SlackMessageEvent;
  }

  const account: ResolvedSlackAccount = {
    accountId: "default",
    enabled: true,
    botTokenSource: "config",
    appTokenSource: "config",
    config: {
      commands: { native: false },
      slashCommand: {
        enabled: true,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
    },
  };

  async function prepare(params: {
    name: string;
    allowFrom?: string[];
    channels?: ChannelUserConfig;
    dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
    groupDmEnabled?: boolean;
    event: Partial<SlackMessageEvent>;
  }) {
    return prepareSlackMessage({
      ctx: createContext(params),
      account,
      message: message(params.event),
      opts: { source: "message" },
    });
  }

  function setProfile(userId: string, profile: ProfileFields) {
    profiles[userId] = profile;
  }

  it("resolves a single-word allowlist name to the member id from users.list", async () => {
    const resolved = await resolveSlackUserAllowlist({
      token: "test-bot-token",
      entries: ["alice"],
      client: directoryClient(),
    });

    expect(resolved).toEqual([
      expect.objectContaining({
        input: "alice",
        resolved: true,
        id: OWNER_ID,
      }),
    ]);
  });

  it("does not let a copied display name through a channel users allowlist", async () => {
    const channels = await resolveConfiguredChannelUsers({
      [CHANNEL_ID]: { allow: true, requireMention: false, users: ["Alice Smith"] },
    });
    setProfile(OWNER_ID, { display_name: "Owner Now", name: "alice-renamed" });
    setProfile(ATTACKER_ID, { display_name: "Alice Smith", name: "mallory" });

    const owner = await prepare({
      name: "channel-users-owner",
      channels,
      event: { user: OWNER_ID, text: "hello" },
    });
    const attacker = await prepare({
      name: "channel-users-attacker",
      channels,
      event: { user: ATTACKER_ID, text: "hello" },
    });

    expect(owner).not.toBeNull();
    expect(attacker).toBeNull();
  });

  it("does not let a copied display name through a single-word channel users entry", async () => {
    const channels = await resolveConfiguredChannelUsers({
      [CHANNEL_ID]: { allow: true, requireMention: false, users: ["alice"] },
    });
    setProfile(OWNER_ID, { display_name: "Owner Now", name: "alice-renamed" });
    setProfile(ATTACKER_ID, { display_name: "alice", name: "mallory" });

    const owner = await prepare({
      name: "channel-word-owner",
      channels,
      event: { user: OWNER_ID, text: "hello" },
    });
    const attacker = await prepare({
      name: "channel-word-attacker",
      channels,
      event: { user: ATTACKER_ID, text: "hello" },
    });

    expect(owner).not.toBeNull();
    expect(attacker).toBeNull();
  });

  it("does not let a display name satisfy a channel users entry that is a user id", async () => {
    const channels: ChannelUserConfig = {
      [CHANNEL_ID]: { allow: true, requireMention: false, users: [OWNER_ID] },
    };
    setProfile(OWNER_ID, { display_name: "Owner Now", name: "alice" });
    setProfile(ATTACKER_ID, { display_name: OWNER_ID, name: "mallory" });

    const owner = await prepare({
      name: "channel-id-owner",
      channels,
      event: { user: OWNER_ID, text: "hello" },
    });
    const attacker = await prepare({
      name: "channel-id-attacker",
      channels,
      event: { user: ATTACKER_ID, text: "hello" },
    });

    expect(owner).not.toBeNull();
    expect(attacker).toBeNull();
  });

  it("does not let a slug of the display name satisfy channel users", async () => {
    const channels: ChannelUserConfig = {
      [CHANNEL_ID]: { allow: true, requireMention: false, users: ["alice-smith", OWNER_ID] },
    };
    setProfile(ATTACKER_ID, { display_name: "Alice Smith", name: "mallory" });

    const attacker = await prepare({
      name: "channel-slug-attacker",
      channels,
      event: { user: ATTACKER_ID, text: "hello" },
    });

    expect(attacker).toBeNull();
  });

  it("does not let a slack-prefixed display name satisfy channel users", async () => {
    const channels: ChannelUserConfig = {
      [CHANNEL_ID]: { allow: true, requireMention: false, users: ["slack:alice", OWNER_ID] },
    };
    setProfile(ATTACKER_ID, { display_name: "alice", name: "mallory" });

    const attacker = await prepare({
      name: "channel-prefixed-attacker",
      channels,
      event: { user: ATTACKER_ID, text: "hello" },
    });

    expect(attacker).toBeNull();
  });

  it("does not let a full name satisfy channel users when display name is empty", async () => {
    const channels = await resolveConfiguredChannelUsers({
      [CHANNEL_ID]: { allow: true, requireMention: false, users: ["Alice Example"] },
    });
    setProfile(ATTACKER_ID, { display_name: "", real_name: "Alice Example", name: "mallory" });
    const byRealName = await prepare({
      name: "channel-real-name",
      channels,
      event: { user: ATTACKER_ID, text: "hello" },
    });

    expect(byRealName).toBeNull();
  });

  it("does not let a username satisfy channel users when profile names are empty", async () => {
    const channels = await resolveConfiguredChannelUsers({
      [CHANNEL_ID]: { allow: true, requireMention: false, users: ["alice"] },
    });
    setProfile(ATTACKER_ID, { display_name: "", real_name: "", name: "alice" });

    const attacker = await prepare({
      name: "channel-username",
      channels,
      event: { user: ATTACKER_ID, text: "hello" },
    });

    expect(attacker).toBeNull();
  });

  it("applies the same channel users gate to private groups", async () => {
    const channels = await resolveConfiguredChannelUsers({
      [GROUP_ID]: { allow: true, requireMention: false, users: ["Alice Smith"] },
    });
    setProfile(ATTACKER_ID, { display_name: "Alice Smith", name: "mallory" });

    const attacker = await prepare({
      name: "group-users-attacker",
      channels,
      event: { channel: GROUP_ID, channel_type: "group", user: ATTACKER_ID, text: "hello" },
    });

    expect(attacker).toBeNull();
  });

  it("does not authorize control commands from a copied allowFrom display name", async () => {
    const allowFrom = await resolveConfiguredAllowFrom(["Alice Smith"]);
    const channels: ChannelUserConfig = {
      [CHANNEL_ID]: { allow: true, requireMention: false },
    };
    setProfile(OWNER_ID, { display_name: "Owner Now", name: "alice-renamed" });
    setProfile(ATTACKER_ID, { display_name: "Alice Smith", name: "mallory" });

    const ownerCommand = await prepare({
      name: "allowfrom-owner-command",
      allowFrom,
      channels,
      event: { user: OWNER_ID, text: "/status" },
    });
    const attackerCommand = await prepare({
      name: "allowfrom-attacker-command",
      allowFrom,
      channels,
      event: { user: ATTACKER_ID, text: "/status" },
    });
    const attackerChat = await prepare({
      name: "allowfrom-attacker-chat",
      allowFrom,
      channels,
      event: { user: ATTACKER_ID, text: "hello" },
    });

    expect(ownerCommand).not.toBeNull();
    expect(ownerCommand?.ctxPayload.CommandAuthorized).toBe(true);
    expect(attackerCommand).toBeNull();
    expect(attackerChat).not.toBeNull();
    expect(attackerChat?.ctxPayload.CommandAuthorized).toBe(false);
  });

  it("does not authorize control commands when the display name copies an allowFrom user id", async () => {
    const channels: ChannelUserConfig = {
      [CHANNEL_ID]: { allow: true, requireMention: false },
    };
    setProfile(OWNER_ID, { display_name: "Owner Now", name: "alice" });
    setProfile(ATTACKER_ID, { display_name: OWNER_ID, name: "mallory" });

    const attackerCommand = await prepare({
      name: "allowfrom-id-command",
      allowFrom: [OWNER_ID],
      channels,
      event: { user: ATTACKER_ID, text: "/status" },
    });
    const attackerChat = await prepare({
      name: "allowfrom-id-chat",
      allowFrom: [OWNER_ID],
      channels,
      event: { user: ATTACKER_ID, text: "hello" },
    });

    expect(attackerCommand).toBeNull();
    expect(attackerChat?.ctxPayload.CommandAuthorized).toBe(false);
  });

  it("does not authorize mpim control commands from a copied allowFrom display name", async () => {
    const allowFrom = await resolveConfiguredAllowFrom(["Alice Smith"]);
    setProfile(ATTACKER_ID, { display_name: "Alice Smith", name: "mallory" });

    const attacker = await prepare({
      name: "mpim-command",
      allowFrom,
      groupDmEnabled: true,
      event: {
        channel: MPIM_ID,
        channel_type: "mpim",
        user: ATTACKER_ID,
        text: "/status",
      },
    });

    expect(attacker).toBeNull();
  });

  it("does not authorize DM control commands from a copied allowFrom display name", async () => {
    const allowFrom = await resolveConfiguredAllowFrom(["Alice Smith"]);
    setProfile(OWNER_ID, { display_name: "Owner Now", name: "alice-renamed" });
    setProfile(ATTACKER_ID, { display_name: "Alice Smith", name: "mallory" });

    const owner = await prepare({
      name: "dm-open-owner",
      allowFrom,
      dmPolicy: "open",
      event: { channel: DM_ID, channel_type: "im", user: OWNER_ID, text: "/status" },
    });
    const attacker = await prepare({
      name: "dm-open-attacker",
      allowFrom,
      dmPolicy: "open",
      event: { channel: DM_ID, channel_type: "im", user: ATTACKER_ID, text: "/status" },
    });

    expect(owner?.ctxPayload.CommandAuthorized).toBe(true);
    expect(attacker).not.toBeNull();
    expect(attacker?.ctxPayload.CommandAuthorized).toBe(false);
  });

  it("keeps DM access restricted to user ids when dmPolicy is allowlist", async () => {
    const allowFrom = await resolveConfiguredAllowFrom(["Alice Smith"]);
    setProfile(ATTACKER_ID, { display_name: "Alice Smith", name: "mallory" });

    const attacker = await prepare({
      name: "dm-allowlist-attacker",
      allowFrom,
      dmPolicy: "allowlist",
      event: { channel: DM_ID, channel_type: "im", user: ATTACKER_ID, text: "hello" },
    });

    expect(attacker).toBeNull();
  });

  async function runSlash(params: {
    name: string;
    allowFrom?: string[];
    channels?: ChannelUserConfig;
    dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
    command: {
      user_id: string;
      user_name: string;
      channel_id: string;
      channel_name: string;
      text: string;
    };
  }) {
    const commands = new Map<unknown, (args: unknown) => Promise<void>>();
    const ctx = createContext(params);
    ctx.app = {
      client: liveClient(),
      command: (name: unknown, handler: (args: unknown) => Promise<void>) => {
        commands.set(name, handler);
      },
    } as App;
    await registerSlackMonitorSlashCommands({ ctx, account });
    const handler = [...commands.values()][0];
    if (!handler) {
      throw new Error("slash command was not registered");
    }
    const respond = vi.fn(async () => undefined);
    const ack = vi.fn(async () => undefined);
    await handler({
      command: { trigger_id: "trigger-1", ...params.command },
      ack,
      respond,
    });
    return { respond };
  }

  function commandAuthorizedFromDispatch(): boolean | undefined {
    const arg = dispatchReplyWithDispatcher.mock.calls.at(-1)?.[0] as
      | { ctx?: { CommandAuthorized?: boolean } }
      | undefined;
    return arg?.ctx?.CommandAuthorized;
  }

  it("does not let a copied display name run a channel slash command", async () => {
    const channels = await resolveConfiguredChannelUsers({
      [CHANNEL_ID]: { allow: true, requireMention: false, users: ["Alice Smith"] },
    });
    setProfile(OWNER_ID, { display_name: "Owner Now", name: "alice-renamed" });
    setProfile(ATTACKER_ID, { display_name: "Alice Smith", name: "mallory" });

    await runSlash({
      name: "slash-channel-owner",
      channels,
      command: {
        user_id: OWNER_ID,
        user_name: "alice-renamed",
        channel_id: CHANNEL_ID,
        channel_name: "ops",
        text: "hello",
      },
    });
    expect(commandAuthorizedFromDispatch()).toBe(true);
    dispatchReplyWithDispatcher.mockClear();
    const attacker = await runSlash({
      name: "slash-channel-attacker",
      channels,
      command: {
        user_id: ATTACKER_ID,
        user_name: "mallory",
        channel_id: CHANNEL_ID,
        channel_name: "ops",
        text: "hello",
      },
    });

    expect(dispatchReplyWithDispatcher).not.toHaveBeenCalled();
    expect(attacker.respond).toHaveBeenCalledWith({
      text: "You are not authorized to use this command here.",
      response_type: "ephemeral",
    });
  });

  it("does not let a copied display name authorize a channel slash command via allowFrom", async () => {
    const allowFrom = await resolveConfiguredAllowFrom(["Alice Smith"]);
    const channels: ChannelUserConfig = {
      [CHANNEL_ID]: { allow: true, requireMention: false },
    };
    setProfile(OWNER_ID, { display_name: "Owner Now", name: "alice-renamed" });
    setProfile(ATTACKER_ID, { display_name: "Alice Smith", name: "mallory" });

    await runSlash({
      name: "slash-allowfrom-owner",
      allowFrom,
      channels,
      command: {
        user_id: OWNER_ID,
        user_name: "alice-renamed",
        channel_id: CHANNEL_ID,
        channel_name: "ops",
        text: "hello",
      },
    });
    expect(commandAuthorizedFromDispatch()).toBe(true);

    dispatchReplyWithDispatcher.mockClear();
    const attacker = await runSlash({
      name: "slash-allowfrom-attacker",
      allowFrom,
      channels,
      command: {
        user_id: ATTACKER_ID,
        user_name: "mallory",
        channel_id: CHANNEL_ID,
        channel_name: "ops",
        text: "hello",
      },
    });

    expect(dispatchReplyWithDispatcher).not.toHaveBeenCalled();
    expect(attacker.respond).toHaveBeenCalledWith({
      text: "You are not authorized to use this command.",
      response_type: "ephemeral",
    });
  });

  it("does not let a copied display name pass a DM slash allowlist", async () => {
    const allowFrom = await resolveConfiguredAllowFrom(["Alice Smith"]);
    setProfile(OWNER_ID, { display_name: "Owner Now", name: "alice-renamed" });
    setProfile(ATTACKER_ID, { display_name: "Alice Smith", name: "mallory" });

    await runSlash({
      name: "slash-dm-owner",
      allowFrom,
      dmPolicy: "allowlist",
      command: {
        user_id: OWNER_ID,
        user_name: "alice-renamed",
        channel_id: DM_ID,
        channel_name: "directmessage",
        text: "hello",
      },
    });
    expect(commandAuthorizedFromDispatch()).toBe(true);

    dispatchReplyWithDispatcher.mockClear();
    const attacker = await runSlash({
      name: "slash-dm-attacker",
      allowFrom,
      dmPolicy: "allowlist",
      command: {
        user_id: ATTACKER_ID,
        user_name: "mallory",
        channel_id: DM_ID,
        channel_name: "directmessage",
        text: "hello",
      },
    });

    expect(dispatchReplyWithDispatcher).not.toHaveBeenCalled();
    expect(attacker.respond).toHaveBeenCalledWith({
      text: "You are not authorized to use this command.",
      response_type: "ephemeral",
    });
  });
});
