import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import { isRemoteMediaUrl, stageSandboxedMediaFile } from "./sandbox-media.js";
import { assertMediaNotDataUrl, resolveSandboxedMediaSource } from "./sandbox-paths.js";
import { resolveSandboxWorkspaceDirForSession } from "./sandbox/context.js";

const log = createSubsystemLogger("agent/sandbox-media");

type MediaPayload = { text?: string; mediaUrl?: string; mediaUrls?: string[] };

/**
 * Applies the sandbox boundary to media a sandboxed session asks the gateway to
 * deliver (reply `MEDIA:` lines, block replies, tool-result media). Remote URLs
 * pass through; local references must resolve inside the session's sandbox
 * workspace and are replaced by a staged copy. Anything else is dropped.
 */
export type SandboxReplyMediaGuard = {
  sandboxRoot: string;
  stageMediaUrls: (urls: readonly string[]) => Promise<string[]>;
  /** Returns null when the payload only carried media and none of it was allowed. */
  stagePayload: <T extends MediaPayload>(
    payload: T,
    opts?: { skipMediaUrls?: ReadonlySet<string> },
  ) => Promise<T | null>;
  stripLocalMedia: <T extends MediaPayload>(payload: T) => T;
  stageText: (text: string) => Promise<string>;
};

function payloadMediaUrls(payload: MediaPayload): string[] {
  if (payload.mediaUrls?.length) {
    return payload.mediaUrls;
  }
  return payload.mediaUrl ? [payload.mediaUrl] : [];
}

function withMediaUrls<T extends MediaPayload>(payload: T, urls: string[]): T {
  const next: T = { ...payload, mediaUrls: urls.length > 0 ? urls : undefined };
  if ("mediaUrl" in payload) {
    next.mediaUrl = urls[0];
  }
  return next;
}

function formatMediaLine(url: string): string {
  return /\s/.test(url) ? `MEDIA:"${url}"` : `MEDIA:${url}`;
}

export function createSandboxReplyMediaGuard(params: {
  sandboxRoot: string;
}): SandboxReplyMediaGuard {
  const { sandboxRoot } = params;

  const stageOne = async (raw: string): Promise<string | undefined> => {
    const value = raw.trim();
    if (!value) {
      return undefined;
    }
    if (isRemoteMediaUrl(value)) {
      return value;
    }
    let resolved: string;
    try {
      assertMediaNotDataUrl(value);
      resolved = await resolveSandboxedMediaSource({ media: value, sandboxRoot });
    } catch (err) {
      log.warn(`Dropped sandboxed reply media outside the sandbox workspace: ${String(err)}`);
      return undefined;
    }
    try {
      return await stageSandboxedMediaFile({ filePath: resolved, sandboxRoot });
    } catch (err) {
      log.warn(`Dropped sandboxed reply media that could not be staged: ${String(err)}`);
      return undefined;
    }
  };

  const stageMediaUrls = async (urls: readonly string[]): Promise<string[]> => {
    const results = await Promise.all(urls.map((url) => stageOne(url)));
    const out: string[] = [];
    for (const url of results) {
      if (url && !out.includes(url)) {
        out.push(url);
      }
    }
    return out;
  };

  return {
    sandboxRoot,
    stageMediaUrls,
    stagePayload: async (payload, opts) => {
      const urls = payloadMediaUrls(payload);
      if (urls.length === 0) {
        return payload;
      }
      const skip = opts?.skipMediaUrls;
      const next = await stageMediaUrls(skip ? urls.filter((url) => !skip.has(url)) : urls);
      if (next.length === 0 && !payload.text?.trim()) {
        return null;
      }
      return withMediaUrls(payload, next);
    },
    stripLocalMedia: (payload) => {
      const urls = payloadMediaUrls(payload);
      if (urls.length === 0) {
        return payload;
      }
      return withMediaUrls(
        payload,
        urls.filter((url) => isRemoteMediaUrl(url)),
      );
    },
    stageText: async (text) => {
      const split = splitMediaFromOutput(text);
      if (!split.mediaUrls?.length) {
        return text;
      }
      const urls = await stageMediaUrls(split.mediaUrls);
      return [
        split.text,
        split.audioAsVoice ? "[[audio_as_voice]]" : "",
        ...urls.map((url) => formatMediaLine(url)),
      ]
        .filter(Boolean)
        .join("\n");
    },
  };
}

export function resolveSandboxReplyMediaGuard(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): SandboxReplyMediaGuard | null {
  const sandboxRoot = resolveSandboxWorkspaceDirForSession(params);
  return sandboxRoot ? createSandboxReplyMediaGuard({ sandboxRoot }) : null;
}

/**
 * For assistant text that is relayed outside the agent run (subagent completion
 * messages, agent-to-agent announces): when the session that wrote it is
 * sandboxed, apply the same media boundary to its `MEDIA:` lines.
 */
export async function stageSandboxedReplyText(params: {
  text: string;
  config?: OpenClawConfig;
  sessionKey?: string;
}): Promise<string> {
  if (!params.text.includes("MEDIA:")) {
    return params.text;
  }
  const agentId = resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.config });
  const guard = resolveSandboxReplyMediaGuard({
    config: params.config,
    sessionKey: params.sessionKey,
    workspaceDir: resolveAgentWorkspaceDir(params.config ?? {}, agentId),
  });
  return guard ? await guard.stageText(params.text) : params.text;
}
