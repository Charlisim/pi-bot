import { createHash } from "node:crypto";
import type {
  BotProfile,
  Conversation,
  ConversationKind,
  RunStatus,
  Workspace,
} from "./types.ts";

export const NO_RESPONSE = "[no response]";

export interface ConversationReplyCompletion {
  runId: string;
  status: "completed" | "failed" | "paused" | "stopped";
  output?: string;
  error?: string;
}

export function botProfileDigest(bot: BotProfile): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: bot.id,
        role: bot.role,
        description: bot.description,
        personality: bot.personality,
        instructions: bot.instructions,
        tools: bot.tools,
        modelPolicy: bot.modelPolicy,
        channelIds: bot.channelIds,
        activation: bot.activation,
        inheritProjectContext: bot.inheritProjectContext,
        version: bot.version,
        createdAt: bot.createdAt,
      }),
    )
    .digest("hex");
}

export function conversationId(
  kind: ConversationKind,
  targetId: string,
): string {
  return `${kind}:${targetId}`;
}

export function findConversation(
  workspace: Workspace,
  kind: ConversationKind,
  targetId: string,
): Conversation | undefined {
  const id = conversationId(kind, targetId);
  return workspace.conversations.find((conversation) => conversation.id === id);
}

export function ensureConversation(
  workspace: Workspace,
  kind: ConversationKind,
  targetId: string,
  now: string,
): Conversation {
  const existing = findConversation(workspace, kind, targetId);
  if (existing) return existing;
  const conversation: Conversation = {
    id: conversationId(kind, targetId),
    kind,
    targetId,
    messages: [],
    contexts: [],
    createdAt: now,
    updatedAt: now,
  };
  workspace.conversations.push(conversation);
  return conversation;
}

export function conversationContextRunId(
  conversation: Conversation,
  bot: BotProfile,
): string | undefined {
  const digest = botProfileDigest(bot);
  const context = conversation.contexts.find((item) => item.botId === bot.id);
  return context?.profileDigest === digest ? context.runId : undefined;
}

export function channelRecipients(
  bots: readonly BotProfile[],
  channelId: string,
  message: string,
): BotProfile[] {
  const assigned = bots.filter((bot) => bot.channelIds.includes(channelId));
  const mentions = [
    ...message.matchAll(/(?<![a-z0-9._%+-])@([a-z0-9][a-z0-9-]{0,63})\b/gi),
  ].map((match) => match[1]?.toLowerCase());
  if (mentions.length === 0) return assigned;
  const assignedById = new Map(assigned.map((bot) => [bot.id, bot]));
  const unknown = mentions.filter((id) => id && !assignedById.has(id));
  if (unknown.length > 0)
    throw new Error(
      `These mentioned bots are not assigned to this channel: ${[...new Set(unknown)].join(", ")}.`,
    );
  return [
    ...new Map(
      mentions
        .map((id) => (id ? assignedById.get(id) : undefined))
        .filter((bot): bot is BotProfile => Boolean(bot))
        .map((bot) => [bot.id, bot]),
    ).values(),
  ];
}

export function applyConversationReply(
  workspace: Workspace,
  event: ConversationReplyCompletion,
  now: string,
): boolean {
  for (const conversation of workspace.conversations) {
    const index = conversation.messages.findIndex(
      (message) => message.runId === event.runId,
    );
    if (index === -1) continue;
    const message = conversation.messages[index];
    if (!message) return false;
    const output = event.output?.replaceAll("\0", "�").trim();
    const error = event.error?.replaceAll("\0", "�").trim();
    if (event.status === "completed" && output?.toLowerCase() === NO_RESPONSE) {
      conversation.messages.splice(index, 1);
    } else {
      const { responseId: _responseId, ...completedMessage } = message;
      conversation.messages[index] = {
        ...completedMessage,
        content:
          output ??
          error ??
          (event.status === "completed"
            ? "No response was returned."
            : `The bot ${event.status}.`),
        status: event.status === "completed" ? "completed" : "failed",
      };
    }
    conversation.updatedAt = now;
    return true;
  }
  return false;
}

export function busyConversationRecipients(
  workspace: Workspace,
  kind: ConversationKind,
  targetId: string,
  recipients: readonly BotProfile[],
): BotProfile[] {
  const conversation = findConversation(workspace, kind, targetId);
  return recipients.filter((recipient) => {
    const runId = conversation?.contexts.find(
      (context) => context.botId === recipient.id,
    )?.runId;
    return workspace.runs.some(
      (run) => run.id === runId && run.status === "launched",
    );
  });
}

export function reconcileConversationRun(
  workspace: Workspace,
  runId: string,
  status: RunStatus,
  output: string | undefined,
  now: string,
): boolean {
  const run = workspace.runs.find((item) => item.id === runId);
  if (
    run?.status !== "launched" ||
    (!output && (status === "launched" || status === "unknown"))
  )
    return false;
  const terminalStatus = output
    ? status === "failed"
      ? "failed"
      : "completed"
    : status;
  run.status = terminalStatus;
  run.updatedAt = now;
  applyConversationReply(
    workspace,
    {
      runId,
      status:
        terminalStatus === "completed" || terminalStatus === "failed"
          ? terminalStatus
          : terminalStatus === "paused"
            ? "paused"
            : "stopped",
      ...(output ? { output } : {}),
    },
    now,
  );
  return true;
}

export function channelTask(
  channelName: string,
  recipientCount: number,
  message: string,
): string {
  return [
    `Message in #${channelName}:`,
    message,
    "",
    `You are one of ${recipientCount} assigned specialist${recipientCount === 1 ? "" : "s"}.`,
    "Reply only with the part relevant to your role and expertise.",
    `If no part is relevant, reply exactly ${NO_RESPONSE}.`,
  ].join("\n");
}
