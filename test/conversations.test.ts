import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConversationReply,
  botProfileDigest,
  busyConversationRecipients,
  channelRecipients,
  channelTask,
  conversationContextRunId,
  ensureConversation,
  NO_RESPONSE,
  reconcileConversationRun,
} from "../src/conversations.ts";
import { createWorkspace } from "../src/store.ts";
import type { BotProfile, Conversation } from "../src/types.ts";

const bots = [
  { id: "atlas", channelIds: ["general"] },
  { id: "sage", channelIds: ["general"] },
  { id: "solo", channelIds: [] },
] as never;

test("channel messages fan out unless they contain bot mentions", () => {
  assert.deepEqual(
    channelRecipients(bots, "general", "Review this").map((bot) => bot.id),
    ["atlas", "sage"],
  );
  assert.deepEqual(
    channelRecipients(bots, "general", "@sage review the domain language").map(
      (bot) => bot.id,
    ),
    ["sage"],
  );
  assert.deepEqual(
    channelRecipients(bots, "general", "please,@atlas review this").map(
      (bot) => bot.id,
    ),
    ["atlas"],
  );
  assert.deepEqual(
    channelRecipients(bots, "general", "email atlas@example.com").map(
      (bot) => bot.id,
    ),
    ["atlas", "sage"],
  );
  assert.throws(
    () => channelRecipients(bots, "general", "@solo review this"),
    /not assigned/,
  );
});

test("bot profile digests invalidate stale runtime authority", () => {
  const profile: BotProfile = {
    id: "atlas",
    name: "Atlas",
    role: "Reviewer",
    description: "Reviews work.",
    personality: {
      summary: "Careful",
      principles: "Verify.",
      boundaries: "Do not edit.",
    },
    instructions: "Review.",
    tools: ["read"],
    modelPolicy: { fallback: [], thinking: "low" },
    channelIds: ["general"],
    activation: { manual: true, mentions: true },
    inheritProjectContext: false,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(botProfileDigest(profile), botProfileDigest({ ...profile }));
  const changed = { ...profile, tools: ["read", "write"] };
  assert.notEqual(botProfileDigest(profile), botProfileDigest(changed));
  const conversation: Conversation = {
    id: "bot:atlas",
    kind: "bot",
    targetId: "atlas",
    messages: [],
    contexts: [
      {
        botId: "atlas",
        runId: "run-old",
        profileDigest: botProfileDigest(profile),
      },
    ],
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
  assert.equal(conversationContextRunId(conversation, profile), "run-old");
  assert.equal(conversationContextRunId(conversation, changed), undefined);
});

test("each bot or channel receives one durable conversation", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  const first = ensureConversation(
    workspace,
    "channel",
    "general",
    workspace.createdAt,
  );
  const second = ensureConversation(
    workspace,
    "channel",
    "general",
    workspace.createdAt,
  );
  assert.equal(first, second);
  assert.equal(workspace.conversations.length, 1);
});

test("busy conversation lanes are rejected before message persistence", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  workspace.bots = bots;
  const conversation = ensureConversation(
    workspace,
    "channel",
    "general",
    workspace.createdAt,
  );
  conversation.contexts.push({ botId: "atlas", runId: "run-active" });
  workspace.runs.push({
    id: "run-active",
    botId: "atlas",
    task: "Reply",
    status: "launched",
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  });
  assert.deepEqual(
    busyConversationRecipients(workspace, "channel", "general", bots).map(
      (bot) => bot.id,
    ),
    ["atlas"],
  );
  assert.equal(conversation.messages.length, 0);
});

test("completion output becomes conversation history and irrelevant replies disappear", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  const conversation = ensureConversation(
    workspace,
    "channel",
    "general",
    workspace.createdAt,
  );
  conversation.messages.push(
    {
      id: "message-1",
      author: "bot",
      botId: "atlas",
      content: "Thinking…",
      status: "pending",
      runId: "run-1",
      responseId: "00000000-0000-4000-8000-000000000001",
      createdAt: workspace.createdAt,
    },
    {
      id: "message-2",
      author: "bot",
      botId: "sage",
      content: "Thinking…",
      status: "pending",
      runId: "run-2",
      responseId: "00000000-0000-4000-8000-000000000002",
      createdAt: workspace.createdAt,
    },
  );

  assert.equal(
    applyConversationReply(
      workspace,
      { runId: "run-1", status: "completed", output: "Relevant\0answer" },
      workspace.updatedAt,
    ),
    true,
  );
  applyConversationReply(
    workspace,
    { runId: "run-2", status: "completed", output: NO_RESPONSE },
    workspace.updatedAt,
  );
  assert.deepEqual(
    conversation.messages.map((message) => message.content),
    ["Relevant�answer"],
  );
  assert.equal(conversation.messages[0]?.status, "completed");
  assert.equal(conversation.messages[0]?.responseId, undefined);
});

test("restart reconciliation restores durable final output", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  const conversation = ensureConversation(
    workspace,
    "bot",
    "atlas",
    workspace.createdAt,
  );
  conversation.messages.push({
    id: "message-pending",
    author: "bot",
    botId: "atlas",
    content: "Thinking…",
    status: "pending",
    runId: "run-recover",
    responseId: "00000000-0000-4000-8000-000000000003",
    createdAt: workspace.createdAt,
  });
  workspace.runs.push({
    id: "run-recover",
    botId: "atlas",
    task: "Recover",
    status: "launched",
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  });

  assert.equal(
    reconcileConversationRun(
      workspace,
      "run-recover",
      "unknown",
      "Recovered answer",
      workspace.updatedAt,
    ),
    true,
  );
  assert.equal(workspace.runs[0]?.status, "completed");
  assert.equal(conversation.messages[0]?.content, "Recovered answer");
  assert.equal(conversation.messages[0]?.responseId, undefined);
});

test("channel prompts constrain each bot to its relevant part", () => {
  const task = channelTask("general", 2, "Plan the release");
  assert.match(task, /one of 2 assigned specialists/);
  assert.match(task, /part relevant to your role/);
  assert.match(task, new RegExp(NO_RESPONSE.replace(/[[\]]/g, "\\$&")));
});
