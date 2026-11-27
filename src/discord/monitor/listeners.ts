import {
  ChannelType,
  type Client,
  MessageCreateListener,
  MessageReactionAddListener,
  MessageReactionRemoveListener,
  PresenceUpdateListener,
  type User,
} from "@buape/carbon";
import type { DmPolicy, GroupPolicy } from "../../config/types.base.js";
import { danger, logVerbose } from "../../globals.js";
import { formatDurationSeconds } from "../../infra/format-time/format-duration.ts";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readChannelAllowFromStore } from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { resolveDiscordAccount } from "../accounts.js";
import {
  allowListMatches,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveGroupDmAllow,
  shouldEmitDiscordReactionNotification,
  type DiscordChannelConfigResolved,
} from "./allow-list.js";
import { formatDiscordReactionEmoji, formatDiscordUserTag } from "./format.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";
import { setPresence } from "./presence-cache.js";

type LoadedConfig = ReturnType<typeof import("../../config/config.js").loadConfig>;
type RuntimeEnv = import("../../runtime.js").RuntimeEnv;
type Logger = ReturnType<typeof import("../../logging/subsystem.js").createSubsystemLogger>;

export type DiscordMessageEvent = Parameters<MessageCreateListener["handle"]>[0];

export type DiscordMessageHandler = (data: DiscordMessageEvent, client: Client) => Promise<void>;

type DiscordReactionEvent = Parameters<MessageReactionAddListener["handle"]>[0];

type DiscordReactionListenerParams = {
  cfg: LoadedConfig;
  accountId: string;
  runtime: RuntimeEnv;
  botUserId?: string;
  guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
  logger: Logger;
  /** Overrides for the account's DM/group access settings; unset fields fall back to config. */
  dmEnabled?: boolean;
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
  groupDmEnabled?: boolean;
  groupDmChannels?: string[];
  groupPolicy?: GroupPolicy;
};

type DiscordReactionAccess = {
  dmEnabled: boolean;
  dmPolicy: DmPolicy;
  allowFrom?: string[];
  groupDmEnabled: boolean;
  groupDmChannels?: string[];
  groupPolicy: GroupPolicy;
};

function resolveDiscordReactionAccess(
  params: DiscordReactionListenerParams,
): DiscordReactionAccess {
  const discordCfg = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId }).config;
  const dmConfig = discordCfg.dm;
  return {
    dmEnabled: params.dmEnabled ?? dmConfig?.enabled ?? true,
    dmPolicy: params.dmPolicy ?? discordCfg.dmPolicy ?? dmConfig?.policy ?? "pairing",
    allowFrom: params.allowFrom ?? discordCfg.allowFrom ?? dmConfig?.allowFrom,
    groupDmEnabled: params.groupDmEnabled ?? dmConfig?.groupEnabled ?? false,
    groupDmChannels: params.groupDmChannels ?? dmConfig?.groupChannels,
    groupPolicy:
      params.groupPolicy ??
      discordCfg.groupPolicy ??
      params.cfg.channels?.defaults?.groupPolicy ??
      "open",
  };
}

const REACTION_LABEL_MAX_CHARS = 100;

// Labels end up inside agent-visible system event text; keep them single-line and bounded.
function sanitizeReactionLabel(value: string): string {
  const flattened = value
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flattened);
  return chars.length > REACTION_LABEL_MAX_CHARS
    ? `${chars.slice(0, REACTION_LABEL_MAX_CHARS).join("")}…`
    : flattened;
}

async function isDiscordDmReactorAllowed(access: DiscordReactionAccess, user: User) {
  if (!access.dmEnabled || access.dmPolicy === "disabled") {
    return false;
  }
  if (access.dmPolicy === "open") {
    return true;
  }
  const storeAllowFrom = await readChannelAllowFromStore("discord").catch(() => []);
  const allowList = normalizeDiscordAllowList(
    [...(access.allowFrom ?? []), ...storeAllowFrom],
    ["discord:", "user:", "pk:"],
  );
  if (!allowList) {
    return false;
  }
  return allowListMatches(allowList, {
    id: user.id,
    name: user.username ?? undefined,
    tag: formatDiscordUserTag(user),
  });
}

const DISCORD_SLOW_LISTENER_THRESHOLD_MS = 30_000;
const discordEventQueueLog = createSubsystemLogger("discord/event-queue");

function logSlowDiscordListener(params: {
  logger: Logger | undefined;
  listener: string;
  event: string;
  durationMs: number;
}) {
  if (params.durationMs < DISCORD_SLOW_LISTENER_THRESHOLD_MS) {
    return;
  }
  const duration = formatDurationSeconds(params.durationMs, {
    decimals: 1,
    unit: "seconds",
  });
  const message = `Slow listener detected: ${params.listener} took ${duration} for event ${params.event}`;
  const logger = params.logger ?? discordEventQueueLog;
  logger.warn("Slow listener detected", {
    listener: params.listener,
    event: params.event,
    durationMs: params.durationMs,
    duration,
    consoleMessage: message,
  });
}

export function registerDiscordListener(listeners: Array<object>, listener: object) {
  if (listeners.some((existing) => existing.constructor === listener.constructor)) {
    return false;
  }
  listeners.push(listener);
  return true;
}

export class DiscordMessageListener extends MessageCreateListener {
  constructor(
    private handler: DiscordMessageHandler,
    private logger?: Logger,
  ) {
    super();
  }

  async handle(data: DiscordMessageEvent, client: Client) {
    const startedAt = Date.now();
    const task = Promise.resolve(this.handler(data, client));
    void task
      .catch((err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord handler failed: ${String(err)}`));
      })
      .finally(() => {
        logSlowDiscordListener({
          logger: this.logger,
          listener: this.constructor.name,
          event: this.type,
          durationMs: Date.now() - startedAt,
        });
      });
  }
}

export class DiscordReactionListener extends MessageReactionAddListener {
  private access: DiscordReactionAccess;

  constructor(private params: DiscordReactionListenerParams) {
    super();
    this.access = resolveDiscordReactionAccess(params);
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    await runDiscordReactionHandler({
      data,
      client,
      action: "added",
      handlerParams: this.params,
      access: this.access,
      listener: this.constructor.name,
      event: this.type,
    });
  }
}

export class DiscordReactionRemoveListener extends MessageReactionRemoveListener {
  private access: DiscordReactionAccess;

  constructor(private params: DiscordReactionListenerParams) {
    super();
    this.access = resolveDiscordReactionAccess(params);
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    await runDiscordReactionHandler({
      data,
      client,
      action: "removed",
      handlerParams: this.params,
      access: this.access,
      listener: this.constructor.name,
      event: this.type,
    });
  }
}

async function runDiscordReactionHandler(params: {
  data: DiscordReactionEvent;
  client: Client;
  action: "added" | "removed";
  handlerParams: DiscordReactionListenerParams;
  access: DiscordReactionAccess;
  listener: string;
  event: string;
}): Promise<void> {
  const startedAt = Date.now();
  try {
    await handleDiscordReactionEvent({
      data: params.data,
      client: params.client,
      action: params.action,
      access: params.access,
      cfg: params.handlerParams.cfg,
      accountId: params.handlerParams.accountId,
      botUserId: params.handlerParams.botUserId,
      guildEntries: params.handlerParams.guildEntries,
      logger: params.handlerParams.logger,
    });
  } finally {
    logSlowDiscordListener({
      logger: params.handlerParams.logger,
      listener: params.listener,
      event: params.event,
      durationMs: Date.now() - startedAt,
    });
  }
}

async function handleDiscordReactionEvent(params: {
  data: DiscordReactionEvent;
  client: Client;
  action: "added" | "removed";
  access: DiscordReactionAccess;
  cfg: LoadedConfig;
  accountId: string;
  botUserId?: string;
  guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
  logger: Logger;
}) {
  try {
    const { data, client, action, access, botUserId, guildEntries } = params;
    if (!("user" in data)) {
      return;
    }
    const user = data.user;
    if (!user || user.bot) {
      return;
    }

    // Early exit: skip bot's own reactions before expensive network calls
    if (botUserId && user.id === botUserId) {
      return;
    }

    const isGuildMessage = Boolean(data.guild_id);
    const guildInfo = isGuildMessage
      ? resolveDiscordGuildEntry({
          guild: data.guild ?? undefined,
          guildEntries,
        })
      : null;
    if (isGuildMessage && guildEntries && Object.keys(guildEntries).length > 0 && !guildInfo) {
      return;
    }

    const channel = await client.fetchChannel(data.channel_id);
    if (!channel) {
      return;
    }
    const channelName = "name" in channel ? (channel.name ?? undefined) : undefined;
    const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
    const channelType = "type" in channel ? channel.type : undefined;
    const isDirectMessage = channelType === ChannelType.DM;
    const isGroupDm = channelType === ChannelType.GroupDM;
    const isThreadChannel =
      channelType === ChannelType.PublicThread ||
      channelType === ChannelType.PrivateThread ||
      channelType === ChannelType.AnnouncementThread;
    // Guild reactions must land in guild channels and non-guild reactions in (group) DMs;
    // anything else cannot be mapped onto an access policy.
    if (isGuildMessage === (isDirectMessage || isGroupDm)) {
      return;
    }
    // Reactions reach the same sessions as messages, so the reacting user must pass the
    // same DM/group gates as a message sender would in preflight.
    if (isDirectMessage && !(await isDiscordDmReactorAllowed(access, user))) {
      logVerbose(
        `discord: drop dm reaction from ${user.id} (dmEnabled=${access.dmEnabled}, dmPolicy=${access.dmPolicy})`,
      );
      return;
    }
    if (isGroupDm) {
      if (!access.groupDmEnabled) {
        return;
      }
      const groupDmAllowed = resolveGroupDmAllow({
        channels: access.groupDmChannels,
        channelId: data.channel_id,
        channelName,
        channelSlug,
      });
      if (!groupDmAllowed) {
        return;
      }
    }
    let parentId = "parentId" in channel ? (channel.parentId ?? undefined) : undefined;
    let parentName: string | undefined;
    let parentSlug = "";
    const memberRoleIds = Array.isArray(data.rawMember?.roles)
      ? data.rawMember.roles.map((roleId: string) => String(roleId))
      : [];
    const isGuildReactionAllowed = (channelConfig: DiscordChannelConfigResolved | null) => {
      if (!isGuildMessage) {
        return true;
      }
      if (channelConfig?.enabled === false) {
        return false;
      }
      const channelAllowed = channelConfig?.allowed !== false;
      const channelAllowlistConfigured =
        Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
      const groupAllowed = isDiscordGroupAllowedByPolicy({
        groupPolicy: access.groupPolicy,
        guildAllowlisted: Boolean(guildInfo),
        channelAllowlistConfigured,
        channelAllowed,
      });
      if (!groupAllowed || !channelAllowed) {
        return false;
      }
      const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
        channelConfig,
        guildInfo,
        memberRoleIds,
        sender: {
          id: user.id,
          name: user.username ?? undefined,
          tag: formatDiscordUserTag(user),
        },
      });
      if (hasAccessRestrictions && !memberAllowed) {
        logVerbose(`discord: drop guild reaction from ${user.id} (not in users/roles allowlist)`);
        return false;
      }
      return true;
    };
    let reactionBase: { baseText: string; contextKey: string } | null = null;
    const resolveReactionBase = () => {
      if (reactionBase) {
        return reactionBase;
      }
      const emojiLabel = sanitizeReactionLabel(formatDiscordReactionEmoji(data.emoji));
      const actorLabel = sanitizeReactionLabel(formatDiscordUserTag(user));
      const guildSlug =
        guildInfo?.slug ||
        (data.guild?.name
          ? normalizeDiscordSlug(data.guild.name)
          : (data.guild_id ?? (isGroupDm ? "group-dm" : "dm")));
      const channelLabel = channelSlug
        ? `#${channelSlug}`
        : channelName
          ? `#${normalizeDiscordSlug(channelName)}`
          : `#${data.channel_id}`;
      const baseText = `Discord reaction ${action}: ${emojiLabel} by ${actorLabel} on ${guildSlug} ${channelLabel} msg ${data.message_id}`;
      const contextKey = `discord:reaction:${action}:${data.message_id}:${user.id}:${emojiLabel}`;
      reactionBase = { baseText, contextKey };
      return reactionBase;
    };
    const emitReaction = (text: string, parentPeerId?: string) => {
      const { contextKey } = resolveReactionBase();
      const route = resolveAgentRoute({
        cfg: params.cfg,
        channel: "discord",
        accountId: params.accountId,
        guildId: data.guild_id ?? undefined,
        memberRoleIds,
        peer: {
          kind: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel",
          id: isDirectMessage ? user.id : data.channel_id,
        },
        parentPeer: parentPeerId ? { kind: "channel", id: parentPeerId } : undefined,
      });
      enqueueSystemEvent(text, {
        sessionKey: route.sessionKey,
        contextKey,
      });
    };
    const shouldNotifyReaction = (options: {
      mode: "off" | "own" | "all" | "allowlist";
      messageAuthorId?: string;
    }) =>
      shouldEmitDiscordReactionNotification({
        mode: options.mode,
        botId: botUserId,
        messageAuthorId: options.messageAuthorId,
        userId: user.id,
        userName: user.username,
        userTag: formatDiscordUserTag(user),
        allowlist: guildInfo?.users,
      });
    const emitReactionWithAuthor = (message: { author?: User } | null) => {
      const { baseText } = resolveReactionBase();
      const authorLabel = message?.author
        ? sanitizeReactionLabel(formatDiscordUserTag(message.author))
        : undefined;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      emitReaction(text, parentId);
    };
    const loadThreadParentInfo = async () => {
      if (!parentId) {
        return;
      }
      const parentInfo = await resolveDiscordChannelInfo(client, parentId);
      parentName = parentInfo?.name;
      parentSlug = parentName ? normalizeDiscordSlug(parentName) : "";
    };
    const resolveThreadChannelConfig = () =>
      resolveDiscordChannelConfigWithFallback({
        guildInfo,
        channelId: data.channel_id,
        channelName,
        channelSlug,
        parentId,
        parentName,
        parentSlug,
        scope: "thread",
      });

    // Parallelize async operations for thread channels
    if (isThreadChannel) {
      const reactionMode = guildInfo?.reactionNotifications ?? "own";

      // Early exit: skip fetching message if notifications are off
      if (reactionMode === "off") {
        return;
      }

      const channelInfoPromise = parentId
        ? Promise.resolve({ parentId })
        : resolveDiscordChannelInfo(client, data.channel_id);

      // Fast path: for "all" and "allowlist" modes, we don't need to fetch the message
      if (reactionMode === "all" || reactionMode === "allowlist") {
        const channelInfo = await channelInfoPromise;
        parentId = channelInfo?.parentId;
        await loadThreadParentInfo();

        const channelConfig = resolveThreadChannelConfig();
        if (!isGuildReactionAllowed(channelConfig)) {
          return;
        }

        // For allowlist mode, check if user is in allowlist first
        if (reactionMode === "allowlist") {
          if (!shouldNotifyReaction({ mode: reactionMode })) {
            return;
          }
        }

        const { baseText } = resolveReactionBase();
        emitReaction(baseText, parentId);
        return;
      }

      // For "own" mode, we need to fetch the message to check the author
      const messagePromise = data.message.fetch().catch(() => null);

      const [channelInfo, message] = await Promise.all([channelInfoPromise, messagePromise]);
      parentId = channelInfo?.parentId;
      await loadThreadParentInfo();

      const channelConfig = resolveThreadChannelConfig();
      if (!isGuildReactionAllowed(channelConfig)) {
        return;
      }

      const messageAuthorId = message?.author?.id ?? undefined;
      if (!shouldNotifyReaction({ mode: reactionMode, messageAuthorId })) {
        return;
      }

      emitReactionWithAuthor(message);
      return;
    }

    // Non-thread channel path
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: data.channel_id,
      channelName,
      channelSlug,
      parentId,
      parentName,
      parentSlug,
      scope: "channel",
    });
    if (!isGuildReactionAllowed(channelConfig)) {
      return;
    }

    const reactionMode = guildInfo?.reactionNotifications ?? "own";

    // Early exit: skip fetching message if notifications are off
    if (reactionMode === "off") {
      return;
    }

    // Fast path: for "all" and "allowlist" modes, we don't need to fetch the message
    if (reactionMode === "all" || reactionMode === "allowlist") {
      // For allowlist mode, check if user is in allowlist first
      if (reactionMode === "allowlist") {
        if (!shouldNotifyReaction({ mode: reactionMode })) {
          return;
        }
      }

      const { baseText } = resolveReactionBase();
      emitReaction(baseText, parentId);
      return;
    }

    // For "own" mode, we need to fetch the message to check the author
    const message = await data.message.fetch().catch(() => null);
    const messageAuthorId = message?.author?.id ?? undefined;
    if (!shouldNotifyReaction({ mode: reactionMode, messageAuthorId })) {
      return;
    }

    emitReactionWithAuthor(message);
  } catch (err) {
    params.logger.error(danger(`discord reaction handler failed: ${String(err)}`));
  }
}

type PresenceUpdateEvent = Parameters<PresenceUpdateListener["handle"]>[0];

export class DiscordPresenceListener extends PresenceUpdateListener {
  private logger?: Logger;
  private accountId?: string;

  constructor(params: { logger?: Logger; accountId?: string }) {
    super();
    this.logger = params.logger;
    this.accountId = params.accountId;
  }

  async handle(data: PresenceUpdateEvent) {
    try {
      const userId =
        "user" in data && data.user && typeof data.user === "object" && "id" in data.user
          ? String(data.user.id)
          : undefined;
      if (!userId) {
        return;
      }
      setPresence(
        this.accountId,
        userId,
        data as import("discord-api-types/v10").GatewayPresenceUpdate,
      );
    } catch (err) {
      const logger = this.logger ?? discordEventQueueLog;
      logger.error(danger(`discord presence handler failed: ${String(err)}`));
    }
  }
}
