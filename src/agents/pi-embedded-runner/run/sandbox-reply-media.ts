import { resolveSandboxReplyMediaGuard } from "../../sandbox-reply-media.js";
import { resolveRunWorkspaceDir } from "../../workspace-run.js";
import type { EmbeddedPiRunResult } from "../types.js";
import type { RunEmbeddedPiAgentParams } from "./params.js";

function createSerialQueue() {
  let tail: Promise<void> = Promise.resolve();
  return {
    run(task: () => void | Promise<void>): Promise<void> {
      const next = tail.then(task);
      tail = next.catch(() => {});
      return next;
    },
    idle(): Promise<void> {
      return tail;
    },
  };
}

/**
 * Runs an embedded agent turn with the sandbox media boundary applied to every
 * payload it emits (block replies, tool results, partials, final payloads) when
 * the session is sandboxed. Callbacks stay ordered and are drained before the
 * result is returned.
 */
export async function runWithSandboxReplyMediaGuard(
  params: RunEmbeddedPiAgentParams,
  run: (params: RunEmbeddedPiAgentParams) => Promise<EmbeddedPiRunResult>,
): Promise<EmbeddedPiRunResult> {
  const { workspaceDir } = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const guard = resolveSandboxReplyMediaGuard({
    config: params.config,
    sessionKey: params.sessionKey?.trim() || params.sessionId,
    workspaceDir,
  });
  if (!guard) {
    return await run(params);
  }

  const blocks = createSerialQueue();
  const tools = createSerialQueue();
  const { onBlockReply, onBlockReplyFlush, onToolResult, onPartialReply, onReasoningStream } =
    params;
  const result = await run({
    ...params,
    onBlockReply: onBlockReply
      ? (payload) =>
          blocks.run(async () => {
            const staged = await guard.stagePayload(payload);
            if (staged) {
              await onBlockReply(staged);
            }
          })
      : undefined,
    onBlockReplyFlush: onBlockReplyFlush ? () => blocks.run(onBlockReplyFlush) : undefined,
    onToolResult: onToolResult
      ? (payload) =>
          tools.run(async () => {
            const staged = await guard.stagePayload(payload);
            if (staged) {
              await onToolResult(staged);
            }
          })
      : undefined,
    onPartialReply: onPartialReply
      ? (payload) => onPartialReply(guard.stripLocalMedia(payload))
      : undefined,
    onReasoningStream: onReasoningStream
      ? (payload) => onReasoningStream(guard.stripLocalMedia(payload))
      : undefined,
  });
  await Promise.all([blocks.idle(), tools.idle()]);

  if (!result.payloads?.length) {
    return result;
  }
  // Messaging-tool media de-duplication compares the raw references the agent
  // used, so apply it before those references are replaced by staged copies.
  const sentMediaUrls = new Set(result.messagingToolSentMediaUrls ?? []);
  const staged = await Promise.all(
    result.payloads.map((payload) => guard.stagePayload(payload, { skipMediaUrls: sentMediaUrls })),
  );
  const payloads = staged.filter((payload) => payload !== null);
  return { ...result, payloads: payloads.length > 0 ? payloads : undefined };
}
