import { readChannelAllowFromStore } from "../../pairing/pairing-store.js";
import {
  allowListMatches,
  normalizeAllowList,
  normalizeAllowListLower,
  resolveSlackAllowListMatch,
  resolveSlackUserAllowed,
} from "./allow-list.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { normalizeSlackChannelType, type SlackMonitorContext } from "./context.js";

export async function resolveSlackEffectiveAllowFrom(ctx: SlackMonitorContext) {
  const storeAllowFrom = await readChannelAllowFromStore("slack").catch(() => []);
  const allowFrom = normalizeAllowList([...ctx.allowFrom, ...storeAllowFrom]);
  const allowFromLower = normalizeAllowListLower(allowFrom);
  return { allowFrom, allowFromLower };
}

/**
 * Sender gate for user-attributed events (reactions, pins) that become system events.
 * Mirrors the message prepare path: DMs need dmPolicy/allowFrom/pairing approval and
 * rooms honor per-channel user allowlists. Call after `ctx.isChannelAllowed`.
 */
export async function isSlackEventSenderAllowed(params: {
  ctx: SlackMonitorContext;
  channelId?: string;
  channelName?: string;
  channelType?: string | null;
  userId?: string;
  userName?: string;
}): Promise<boolean> {
  const { ctx, channelId, userId } = params;
  const channelType = normalizeSlackChannelType(params.channelType, channelId);
  if (channelType === "im") {
    if (!userId || !ctx.dmEnabled || ctx.dmPolicy === "disabled") {
      return false;
    }
    if (ctx.dmPolicy === "open") {
      return true;
    }
    const { allowFromLower } = await resolveSlackEffectiveAllowFrom(ctx);
    return resolveSlackAllowListMatch({ allowList: allowFromLower, id: userId }).allowed;
  }
  if ((channelType === "channel" || channelType === "group") && channelId) {
    const channelConfig = resolveSlackChannelConfig({
      channelId,
      channelName: params.channelName,
      channels: ctx.channelsConfig,
      defaultRequireMention: ctx.defaultRequireMention,
    });
    return resolveSlackUserAllowed({
      allowList: channelConfig?.users,
      userId,
      userName: params.userName,
    });
  }
  return true;
}

export function isSlackSenderAllowListed(params: {
  allowListLower: string[];
  senderId: string;
  senderName?: string;
}) {
  const { allowListLower, senderId, senderName } = params;
  return (
    allowListLower.length === 0 ||
    allowListMatches({
      allowList: allowListLower,
      id: senderId,
      name: senderName,
    })
  );
}
