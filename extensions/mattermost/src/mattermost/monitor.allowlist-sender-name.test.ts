/**
 * Allowlist decisions must follow the Mattermost user id and the username
 * looked up for that id. These tests build the websocket `posted` event the
 * way Mattermost Server v12.1.0 does, then run that event through
 * monitorMattermostProvider.
 *
 * Mattermost sources (tag v12.1.0):
 * - server/channels/app/notification.go:717 and :1668-1682
 * - server/public/model/user.go:888-915
 * - server/public/model/post.go:636-695 and server/channels/app/post.go:268-349
 * - server/channels/app/webhook.go:467-472 and :1123-1135
 * - server/public/model/config.go:84-86, :639, :839
 */
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCommandAuthorization } from "../../../../src/auto-reply/command-auth.ts";
import { hasControlCommand } from "../../../../src/auto-reply/command-detection.ts";
import { shouldHandleTextCommands } from "../../../../src/auto-reply/commands-registry.ts";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../../../src/auto-reply/inbound-debounce.ts";
import { resolveMattermostGroupRequireMention } from "../group-mentions.ts";
import { setMattermostRuntime } from "../runtime.ts";
import type { MattermostWebSocketLike } from "./monitor-websocket.ts";
import { monitorMattermostProvider } from "./monitor.ts";

const SHOW_USERNAME = "username";
const SHOW_NICKNAME_FULL_NAME = "nickname_full_name";
const SHOW_FULL_NAME = "full_name";
const CHANNEL_DIRECT = "D";
const BOT_USER_ID = "bot-user-id";
const BOT_USERNAME = "openclawbot";
const ALICE_USER_ID = "alice-user-id";
const MALLORY_USER_ID = "mallory-user-id";
const HOOK_OWNER_USER_ID = "hook-owner-user-id";
const BASE_URL = "https://chat.example.test";

type MmUser = {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  nickname: string;
};

type MmProps = Record<string, unknown>;

type ServerSettings = {
  /** ServiceSettings.EnablePostUsernameOverride. Default false (config.go:839). */
  enablePostUsernameOverride: boolean;
  /** TeamSettings.TeammateNameDisplay. Not consulted for websocket sender_name. */
  teammateNameDisplay: string;
  /** ServiceSettings.EnableIncomingWebhooks. Default true (config.go:639). */
  enableIncomingWebhooks: boolean;
};

const alice: MmUser = {
  id: ALICE_USER_ID,
  username: "alice",
  first_name: "Alice",
  last_name: "Example",
  nickname: "ace",
};

const mallory: MmUser = {
  id: MALLORY_USER_ID,
  username: "mallory",
  first_name: "alice",
  last_name: "",
  nickname: "alice",
};

const hookOwner: MmUser = {
  id: HOOK_OWNER_USER_ID,
  username: "hookowner",
  first_name: "Hook",
  last_name: "Owner",
  nickname: "",
};

const directory: Record<string, MmUser> = {
  [alice.id]: alice,
  [mallory.id]: mallory,
  [hookOwner.id]: hookOwner,
};

function fullName(user: MmUser): string {
  if (user.first_name !== "" && user.last_name !== "") {
    return `${user.first_name} ${user.last_name}`;
  }
  if (user.first_name !== "") {
    return user.first_name;
  }
  if (user.last_name !== "") {
    return user.last_name;
  }
  return "";
}

/** server/public/model/user.go getDisplayName / GetDisplayNameWithPrefix. */
function displayNameWithPrefix(user: MmUser, nameFormat: string, prefix: string): string {
  let displayName = prefix + user.username;
  if (nameFormat === SHOW_NICKNAME_FULL_NAME) {
    if (user.nickname !== "") {
      displayName = user.nickname;
    } else {
      const full = fullName(user);
      if (full !== "") {
        displayName = full;
      }
    }
  } else if (nameFormat === SHOW_FULL_NAME) {
    const full = fullName(user);
    if (full !== "") {
      displayName = full;
    }
  }
  return displayName;
}

/**
 * server/channels/app/notification.go PostNotification.GetSenderName.
 * The posted event always calls this with ShowUsername, ignoring TeammateNameDisplay.
 */
function senderNameForPost(params: {
  postType: string;
  props: MmProps;
  channelType: string;
  overridesAllowed: boolean;
  sender: MmUser;
}): string {
  if (params.postType.startsWith("system_")) {
    return "System";
  }
  if (params.overridesAllowed && params.channelType !== CHANNEL_DIRECT) {
    const value = params.props.override_username;
    if (value != null && params.props.from_webhook === "true" && typeof value === "string") {
      return value;
    }
  }
  return displayNameWithPrefix(params.sender, SHOW_USERNAME, "@");
}

const STRIPPED_IDENTITY_PROPS = [
  "from_webhook",
  "from_bot",
  "from_oauth_app",
  "from_plugin",
  "override_username",
  "override_icon_url",
  "override_icon_emoji",
  "webhook_display_name",
];

/** server/public/model/post.go SanitizeProps for a locally created post. */
function sanitizeProps(props: MmProps): MmProps {
  const next = { ...props };
  for (const key of STRIPPED_IDENTITY_PROPS) {
    delete next[key];
  }
  return next;
}

function postedPayload(params: {
  postId: string;
  sender: MmUser;
  channelId: string;
  channelType: string;
  message: string;
  props: MmProps;
  senderName: string;
}) {
  const post = {
    id: params.postId,
    user_id: params.sender.id,
    channel_id: params.channelId,
    message: params.message,
    type: "",
    props: params.props,
    file_ids: [],
    root_id: "",
    create_at: 1_700_000_000_000,
  };
  return {
    event: "posted",
    data: {
      post: JSON.stringify(post),
      channel_type: params.channelType,
      channel_name: params.channelType === CHANNEL_DIRECT ? "dm" : "town-square",
      channel_display_name: params.channelType === CHANNEL_DIRECT ? "dm" : "Town Square",
      sender_name: params.senderName,
      team_id: "team-1",
    },
    broadcast: {
      channel_id: params.channelId,
      team_id: "team-1",
      user_id: params.sender.id,
    },
  };
}

/**
 * A signed-in user's create-post. SanitizeProps strips override props and
 * CreatePost does not re-inject them (no FromIncomingWebhook flag).
 */
function eventFromSignedInUser(params: {
  postId: string;
  sender: MmUser;
  channelId: string;
  channelType: string;
  message: string;
  clientProps?: MmProps;
  server: ServerSettings;
}) {
  const props = sanitizeProps(params.clientProps ?? {});
  const senderName = senderNameForPost({
    postType: "",
    props,
    channelType: params.channelType,
    overridesAllowed: params.server.enablePostUsernameOverride,
    sender: params.sender,
  });
  return postedPayload({ ...params, props, senderName });
}

/**
 * Incoming webhook. HandleIncomingWebhook copies req.Username, and
 * CreateWebhookPost keeps it only when username overrides are enabled.
 * CreatePost then re-injects from_webhook and that override.
 * Returns null when incoming webhooks are disabled (no event is published).
 */
function eventFromIncomingWebhook(params: {
  postId: string;
  owner: MmUser;
  channelId: string;
  channelType: string;
  message: string;
  requestUsername: string;
  hookUsername: string;
  server: ServerSettings;
}) {
  if (!params.server.enableIncomingWebhooks) {
    return null;
  }
  const requested = params.requestUsername !== "" ? params.requestUsername : params.hookUsername;
  const props: MmProps = { from_webhook: "true" };
  if (params.server.enablePostUsernameOverride && requested !== "") {
    props.override_username = requested;
  }
  const senderName = senderNameForPost({
    postType: "",
    props,
    channelType: params.channelType,
    overridesAllowed: params.server.enablePostUsernameOverride,
    sender: params.owner,
  });
  return postedPayload({
    postId: params.postId,
    sender: params.owner,
    channelId: params.channelId,
    channelType: params.channelType,
    message: params.message,
    props,
    senderName,
  });
}

class FakeWebSocket implements MattermostWebSocketLike {
  openListenerCount = 0;
  private openListeners: Array<() => void> = [];
  private messageListeners: Array<(data: Buffer) => void | Promise<void>> = [];
  private closeListeners: Array<(code: number, reason: Buffer) => void> = [];
  private errorListeners: Array<(err: unknown) => void> = [];
  private delivery: Promise<void> = Promise.resolve();

  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer) => void | Promise<void>): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  on(event: "open" | "message" | "close" | "error", listener: unknown): void {
    if (event === "open") {
      this.openListeners.push(listener as () => void);
      this.openListenerCount += 1;
      return;
    }
    if (event === "message") {
      this.messageListeners.push(listener as (data: Buffer) => void | Promise<void>);
      return;
    }
    if (event === "close") {
      this.closeListeners.push(listener as (code: number, reason: Buffer) => void);
      return;
    }
    this.errorListeners.push(listener as (err: unknown) => void);
  }

  send(): void {}

  close(): void {
    this.emitClose(1000);
  }

  terminate(): void {
    this.emitClose(1000);
  }

  emitOpen(): void {
    for (const listener of this.openListeners) {
      listener();
    }
  }

  emitMessage(data: Buffer): void {
    this.delivery = Promise.all(this.messageListeners.map((listener) => listener(data))).then(
      () => undefined,
    );
  }

  async waitForDelivery(): Promise<void> {
    await this.delivery;
  }

  private emitClose(code: number): void {
    const reason = Buffer.alloc(0);
    for (const listener of this.closeListeners) {
      listener(code, reason);
    }
  }
}

type Dispatched = {
  messageId?: string;
  senderId?: string;
  senderName?: string;
  commandAuthorized?: boolean;
  body?: string;
};

function allowlistConfig(allowFrom: string[]): OpenClawConfig {
  return {
    channels: {
      mattermost: {
        enabled: true,
        botToken: "bot-token-placeholder",
        baseUrl: BASE_URL,
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        allowFrom,
        groupAllowFrom: allowFrom,
      },
    },
  } as OpenClawConfig;
}

function createRuntime(dispatched: Dispatched[]): PluginRuntime {
  return {
    version: "test",
    config: {
      loadConfig: vi.fn(() => ({})),
      writeConfigFile: vi.fn(),
    },
    system: {
      enqueueSystemEvent: vi.fn(),
      runCommandWithTimeout: vi.fn(),
      formatNativeDependencyHint: vi.fn(() => ""),
    },
    media: {
      loadWebMedia: vi.fn(),
      detectMime: vi.fn(),
      mediaKindFromMime: vi.fn(),
      isVoiceCompatibleAudio: vi.fn(),
      getImageMetadata: vi.fn(),
      resizeToJpeg: vi.fn(),
    },
    tts: { textToSpeechTelephony: vi.fn() },
    tools: {
      createMemoryGetTool: vi.fn(),
      createMemorySearchTool: vi.fn(),
      registerMemoryCli: vi.fn(),
    },
    channel: {
      text: {
        chunkMarkdownText: vi.fn((text: string) => [text]),
        chunkText: vi.fn((text: string) => [text]),
        chunkByNewline: vi.fn((text: string) => [text]),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
        chunkTextWithMode: vi.fn((text: string) => [text]),
        resolveChunkMode: vi.fn(() => "length"),
        resolveTextChunkLimit: vi.fn(() => 4000),
        hasControlCommand: (text: string, cfg: OpenClawConfig) => hasControlCommand(text, cfg),
        resolveMarkdownTableMode: vi.fn(() => "code"),
        convertMarkdownTables: vi.fn((text: string) => text),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        createReplyDispatcherWithTyping: vi.fn(() => ({
          dispatcher: {},
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        })),
        resolveEffectiveMessagesConfig: vi.fn(),
        resolveHumanDelayConfig: vi.fn(),
        dispatchReplyFromConfig: vi.fn(async (params: { ctx: Record<string, unknown> }) => {
          dispatched.push({
            messageId:
              typeof params.ctx.MessageSid === "string" ? params.ctx.MessageSid : undefined,
            senderId: typeof params.ctx.SenderId === "string" ? params.ctx.SenderId : undefined,
            senderName:
              typeof params.ctx.SenderName === "string" ? params.ctx.SenderName : undefined,
            commandAuthorized: params.ctx.CommandAuthorized === true,
            body: typeof params.ctx.BodyForAgent === "string" ? params.ctx.BodyForAgent : undefined,
          });
        }),
        finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => ctx),
        formatAgentEnvelope: vi.fn((opts: { body: string }) => opts.body),
        formatInboundEnvelope: vi.fn((opts: { body: string }) => opts.body),
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "main",
          accountId: "default",
          sessionKey: "agent:main:mattermost:test",
          mainSessionKey: "agent:main:main",
        })),
      },
      pairing: {
        buildPairingReply: vi.fn(() => "pairing"),
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "PAIR", created: true })),
      },
      media: {
        fetchRemoteMedia: vi.fn(),
        saveMediaBuffer: vi.fn(),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/openclaw-mattermost-sessions.json"),
        readSessionUpdatedAt: vi.fn(),
        recordInboundSession: vi.fn(),
        recordSessionMetaFromInbound: vi.fn(),
        updateLastRoute: vi.fn(async () => {}),
      },
      mentions: {
        buildMentionRegexes: vi.fn(() => []),
        matchesMentionPatterns: vi.fn(() => false),
        matchesMentionWithExplicit: vi.fn(() => false),
      },
      reactions: {
        shouldAckReaction: vi.fn(() => false),
        removeAckReactionAfterReply: vi.fn(),
      },
      groups: {
        resolveGroupPolicy: vi.fn(() => "allowlist"),
        resolveRequireMention: resolveMattermostGroupRequireMention,
      },
      debounce: {
        createInboundDebouncer,
        resolveInboundDebounceMs,
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers: vi.fn(),
        isControlCommandMessage: vi.fn(),
        shouldComputeCommandAuthorized: vi.fn(),
        shouldHandleTextCommands,
      },
      discord: {},
      activity: { record: vi.fn() },
      line: {},
      slack: {},
      telegram: {},
      signal: {},
      imessage: {},
      whatsapp: {},
    },
    logging: {
      shouldLogVerbose: vi.fn(() => false),
      getChildLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    },
    state: { resolveStateDir: vi.fn(() => "/tmp/openclaw") },
  } as unknown as PluginRuntime;
}

function installFetch(users: Record<string, MmUser | null>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw);
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (method === "GET" && url.pathname === "/api/v4/users/me") {
        return json({ id: BOT_USER_ID, username: BOT_USERNAME });
      }
      const userMatch = url.pathname.match(/^\/api\/v4\/users\/([^/]+)$/);
      if (method === "GET" && userMatch) {
        const user = users[decodeURIComponent(userMatch[1] ?? "")];
        if (!user) {
          return json({ message: "user not found" }, 404);
        }
        return json(user);
      }
      const channelMatch = url.pathname.match(/^\/api\/v4\/channels\/([^/]+)$/);
      if (method === "GET" && channelMatch) {
        const channelId = decodeURIComponent(channelMatch[1] ?? "");
        const channelType = channelId.startsWith("dm-") ? CHANNEL_DIRECT : "O";
        return json({
          id: channelId,
          name: channelType === CHANNEL_DIRECT ? "dm" : "town-square",
          display_name: channelType === CHANNEL_DIRECT ? "dm" : "Town Square",
          type: channelType,
          team_id: "team-1",
        });
      }
      if (method === "POST") {
        return json({ id: "outbound-post" });
      }
      return json({ message: "unexpected request" }, 500);
    }),
  );
}

async function deliverEvents(params: {
  cfg: OpenClawConfig;
  events: unknown[];
  users?: Record<string, MmUser | null>;
}): Promise<Dispatched[]> {
  const dispatched: Dispatched[] = [];
  setMattermostRuntime(createRuntime(dispatched));
  installFetch(params.users ?? directory);
  const socket = new FakeWebSocket();
  const abort = new AbortController();
  const runtime: RuntimeEnv = {
    log: () => {},
    error: () => {},
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
  const pending = monitorMattermostProvider({
    config: params.cfg,
    botToken: "bot-token-placeholder",
    baseUrl: BASE_URL,
    abortSignal: abort.signal,
    runtime,
    webSocketFactory: () => socket,
  });
  await vi.waitFor(() => {
    expect(socket.openListenerCount).toBeGreaterThan(0);
  });
  socket.emitOpen();
  for (const event of params.events) {
    socket.emitMessage(Buffer.from(JSON.stringify(event)));
    await socket.waitForDelivery();
  }
  abort.abort();
  await pending;
  return dispatched;
}

function enterpriseNameSettings(display: string): ServerSettings {
  return {
    enablePostUsernameOverride: false,
    teammateNameDisplay: display,
    enableIncomingWebhooks: true,
  };
}

describe("mattermost allowlist sender identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not let a first name or nickname pass an @username allowlist", async () => {
    const cfg = allowlistConfig(["@alice"]);
    for (const display of [SHOW_FULL_NAME, SHOW_NICKNAME_FULL_NAME, SHOW_USERNAME]) {
      const server = enterpriseNameSettings(display);
      const events = [
        eventFromSignedInUser({
          postId: `dm-name-${display}`,
          sender: mallory,
          channelId: "dm-mallory",
          channelType: CHANNEL_DIRECT,
          message: "/status",
          server,
        }),
        eventFromSignedInUser({
          postId: `ch-name-${display}`,
          sender: mallory,
          channelId: "channel-town",
          channelType: "O",
          message: "/status",
          server,
        }),
        eventFromSignedInUser({
          postId: `ch-chat-${display}`,
          sender: mallory,
          channelId: "channel-town",
          channelType: "G",
          message: `@${BOT_USERNAME} hello`,
          server,
        }),
      ];
      for (const event of events) {
        expect(event.data.sender_name).toBe("@mallory");
      }
      const dispatched = await deliverEvents({ cfg, events });
      expect(dispatched).toEqual([]);
    }
  });

  it("does not let forged post props pass an @username allowlist", async () => {
    const cfg = allowlistConfig(["@alice"]);
    const server: ServerSettings = {
      enablePostUsernameOverride: true,
      teammateNameDisplay: SHOW_FULL_NAME,
      enableIncomingWebhooks: true,
    };
    const event = eventFromSignedInUser({
      postId: "forged-props",
      sender: mallory,
      channelId: "channel-town",
      channelType: "O",
      message: "/status",
      clientProps: { from_webhook: "true", override_username: "alice" },
      server,
    });
    expect(event.data.sender_name).toBe("@mallory");
    const dispatched = await deliverEvents({ cfg, events: [event] });
    expect(dispatched).toEqual([]);
  });

  it("does not let a webhook username override pass a direct-message allowlist", async () => {
    const cfg = allowlistConfig(["@alice"]);
    const server: ServerSettings = {
      enablePostUsernameOverride: true,
      teammateNameDisplay: SHOW_USERNAME,
      enableIncomingWebhooks: true,
    };
    const event = eventFromIncomingWebhook({
      postId: "hook-dm",
      owner: hookOwner,
      channelId: "dm-hook",
      channelType: CHANNEL_DIRECT,
      message: "/status",
      requestUsername: "alice",
      hookUsername: "",
      server,
    });
    expect(event).not.toBeNull();
    expect(event?.data.sender_name).toBe("@hookowner");
    const dispatched = await deliverEvents({ cfg, events: [event] });
    expect(dispatched).toEqual([]);
  });

  it("does not let a webhook username override pass channel or group allowlists", async () => {
    const cfg = allowlistConfig(["@alice"]);
    const server: ServerSettings = {
      enablePostUsernameOverride: true,
      teammateNameDisplay: SHOW_FULL_NAME,
      enableIncomingWebhooks: true,
    };
    const overrides = ["alice", "@alice", "Alice"];
    const channelTypes = ["O", "P", "G"];
    const messages = ["/status", `@${BOT_USERNAME} hello`];
    const events = [];
    for (const requestUsername of overrides) {
      for (const channelType of channelTypes) {
        for (const message of messages) {
          const event = eventFromIncomingWebhook({
            postId: `hook-${requestUsername}-${channelType}-${message.length}`,
            owner: hookOwner,
            channelId: `channel-${channelType}`,
            channelType,
            message,
            requestUsername,
            hookUsername: "hookowner",
            server,
          });
          expect(event).not.toBeNull();
          expect(event?.data.sender_name).toBe(requestUsername);
          events.push(event);
        }
      }
    }
    const dispatched = await deliverEvents({ cfg, events });
    expect(dispatched).toEqual([]);
  });

  it("does not authorize a webhook override when the sender user lookup fails", async () => {
    const cfg = allowlistConfig(["@alice"]);
    const server: ServerSettings = {
      enablePostUsernameOverride: true,
      teammateNameDisplay: SHOW_USERNAME,
      enableIncomingWebhooks: true,
    };
    const event = eventFromIncomingWebhook({
      postId: "hook-lookup-miss",
      owner: hookOwner,
      channelId: "channel-town",
      channelType: "O",
      message: "/status",
      requestUsername: "alice",
      hookUsername: "",
      server,
    });
    const dispatched = await deliverEvents({
      cfg,
      events: [event],
      users: { [HOOK_OWNER_USER_ID]: null, [ALICE_USER_ID]: alice },
    });
    expect(dispatched).toEqual([]);
  });

  it("still runs an allowlisted username and an allowlisted user id", async () => {
    const byName = allowlistConfig(["@alice"]);
    const dm = eventFromSignedInUser({
      postId: "alice-dm",
      sender: alice,
      channelId: "dm-alice",
      channelType: CHANNEL_DIRECT,
      message: "/status",
      server: enterpriseNameSettings(SHOW_FULL_NAME),
    });
    const channel = eventFromSignedInUser({
      postId: "alice-channel",
      sender: alice,
      channelId: "channel-town",
      channelType: "O",
      message: "/status",
      server: enterpriseNameSettings(SHOW_NICKNAME_FULL_NAME),
    });
    expect(dm.data.sender_name).toBe("@alice");
    const allowed = await deliverEvents({ cfg: byName, events: [dm, channel] });
    expect(allowed.map((entry) => entry.messageId).toSorted()).toEqual([
      "alice-channel",
      "alice-dm",
    ]);
    for (const entry of allowed) {
      expect(entry.senderId).toBe(ALICE_USER_ID);
      expect(entry.commandAuthorized).toBe(true);
      expect(entry.body).toBe("/status");
      const auth = resolveCommandAuthorization({
        ctx: {
          Provider: "mattermost",
          Surface: "mattermost",
          OriginatingChannel: "mattermost",
          From: `mattermost:${ALICE_USER_ID}`,
          To: entry.messageId === "alice-dm" ? `user:${ALICE_USER_ID}` : "channel:channel-town",
          SenderId: ALICE_USER_ID,
          SenderName: entry.senderName,
          AccountId: "default",
          CommandAuthorized: true,
        },
        cfg: byName,
        commandAuthorized: true,
      });
      expect(auth.isAuthorizedSender).toBe(true);
    }

    const byId = allowlistConfig([MALLORY_USER_ID]);
    const spoofedName = eventFromIncomingWebhook({
      postId: "mallory-id",
      owner: mallory,
      channelId: "channel-town",
      channelType: "O",
      message: `/status`,
      requestUsername: "alice",
      hookUsername: "",
      server: {
        enablePostUsernameOverride: true,
        teammateNameDisplay: SHOW_USERNAME,
        enableIncomingWebhooks: true,
      },
    });
    const idAllowed = await deliverEvents({ cfg: byId, events: [spoofedName] });
    expect(idAllowed).toEqual([
      expect.objectContaining({
        messageId: "mallory-id",
        senderId: MALLORY_USER_ID,
        commandAuthorized: true,
      }),
    ]);
  });

  it("does not reuse an allowlisted sender for the next post from a different user id", async () => {
    const cfg = allowlistConfig(["@alice"]);
    const server: ServerSettings = {
      enablePostUsernameOverride: true,
      teammateNameDisplay: SHOW_FULL_NAME,
      enableIncomingWebhooks: true,
    };
    const alicePost = eventFromSignedInUser({
      postId: "alice-then",
      sender: alice,
      channelId: "channel-town",
      channelType: "O",
      message: "/status",
      server,
    });
    const hookPost = eventFromIncomingWebhook({
      postId: "hook-after",
      owner: hookOwner,
      channelId: "channel-town",
      channelType: "O",
      message: "/status",
      requestUsername: "alice",
      hookUsername: "",
      server,
    });
    const dispatched = await deliverEvents({ cfg, events: [alicePost, hookPost] });
    expect(dispatched.map((entry) => entry.messageId)).toEqual(["alice-then"]);
    expect(dispatched[0]?.senderId).toBe(ALICE_USER_ID);
  });
});
