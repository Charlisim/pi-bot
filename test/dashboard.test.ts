import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  ConversationView,
  type ConversationViewAction,
  Dashboard,
  type DashboardAction,
  RunDetails,
  renderDashboard,
} from "../src/dashboard.ts";
import { createWorkspace } from "../src/store.ts";
import type { Conversation } from "../src/types.ts";

const snapshot = {
  workspace: createWorkspace(
    "Demo",
    "/tmp/demo",
    new Date("2026-01-01T00:00:00.000Z"),
  ),
  engineReady: false,
};

test("empty dashboard states that no default agents are installed", () => {
  const output = renderDashboard(snapshot, 88).join("\n");
  assert.match(output, /agent desk is empty/);
  assert.match(output, /no default agents/);
  assert.match(output, /engine unavailable/);
});

test("dashboard never exceeds the requested terminal width", () => {
  for (const width of [10, 20, 31, 40, 72, 100, 132]) {
    for (const line of renderDashboard(snapshot, width))
      assert.ok(
        visibleWidth(line) <= width,
        `${visibleWidth(line)} > ${width}: ${line}`,
      );
  }
});

test("left and right move focus between dashboard columns", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  workspace.bots = [
    { id: "bot-1", name: "Atlas", role: "Reviewer", tools: [] },
  ] as never;
  workspace.channels = [
    {
      id: "channel-1",
      name: "general",
      topic: "General work",
      createdAt: workspace.createdAt,
    },
    {
      id: "channel-2",
      name: "reviews",
      topic: "Review work",
      createdAt: workspace.createdAt,
    },
  ];
  workspace.runs = [
    {
      id: "run-1",
      botId: "bot-1",
      task: "Review the API",
      status: "completed",
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    },
    {
      id: "run-2",
      botId: "bot-1",
      task: "Review the UI",
      status: "launched",
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    },
  ];
  const actions: DashboardAction[] = [];
  const dashboard = new Dashboard(
    { workspace, engineReady: true },
    {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme,
    (action) => actions.push(action),
    () => undefined,
  );

  dashboard.handleInput("\r");
  dashboard.handleInput("\u001b[C");
  assert.match(dashboard.render(120).join("\n"), /> # general/);
  dashboard.handleInput("\r");
  dashboard.handleInput("\u001b[B");
  assert.match(dashboard.render(120).join("\n"), /> # reviews/);
  dashboard.handleInput("\u001b[C");
  assert.match(dashboard.render(120).join("\n"), /> launched/);
  dashboard.handleInput("\u001b[B");
  for (const width of [30, 72, 120]) {
    const lines = dashboard.render(width);
    assert.match(lines.join("\n"), /> completed/);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  dashboard.handleInput("\r");
  assert.deepEqual(actions, [
    { type: "inspect-bot", botId: "bot-1" },
    { type: "inspect-channel", channelId: "channel-1" },
    { type: "inspect-run", runId: "run-1" },
  ]);
});

test("retained runs stay reachable after the last bot is deleted", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  workspace.runs = [
    {
      id: "run-retained",
      botId: "deleted-bot",
      task: "Keep this receipt",
      status: "completed",
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    },
  ];
  const actions: DashboardAction[] = [];
  const dashboard = new Dashboard(
    { workspace, engineReady: true },
    {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme,
    (action) => actions.push(action),
    () => undefined,
  );

  dashboard.handleInput("\u001b[C");
  dashboard.handleInput("\u001b[C");
  for (const width of [30, 72, 120]) {
    const output = dashboard.render(width).join("\n");
    assert.match(output, /completed/);
    assert.match(output, /run-reta|RECENT RUNS/);
  }
  dashboard.handleInput("\r");
  assert.deepEqual(actions, [{ type: "inspect-run", runId: "run-retained" }]);
});

test("run details ignore the opening Enter and close with Escape", () => {
  let closed = false;
  const details = new RunDetails(
    {
      id: "run-1",
      botId: "bot-1",
      task: "Review a long task without overflowing the terminal width.",
      status: "completed",
      createdAt: snapshot.workspace.createdAt,
      updatedAt: snapshot.workspace.updatedAt,
    },
    "Atlas",
    "Run run-1 completed successfully with runtime details.",
    {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme,
    () => {
      closed = true;
    },
  );

  for (const width of [20, 72, 120])
    for (const line of details.render(width))
      assert.ok(visibleWidth(line) <= width);
  details.handleInput("\r");
  assert.equal(closed, false);
  details.handleInput("\u001b");
  assert.equal(closed, true);
});

test("conversation views show full scrollable history and accept messages", () => {
  const theme = {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const conversation = {
    id: "channel:general",
    kind: "channel",
    targetId: "general",
    messages: Array.from({ length: 25 }, (_, index) => ({
      id: `message-${index}`,
      author: index % 2 ? "bot" : "user",
      ...(index % 2 ? { botId: "atlas" } : {}),
      content: `Message ${index}`,
      status: "completed",
      createdAt: snapshot.workspace.createdAt,
    })),
    contexts: [],
    createdAt: snapshot.workspace.createdAt,
    updatedAt: snapshot.workspace.updatedAt,
  } as Conversation;
  conversation.messages.push({
    id: "message-unsafe",
    author: "bot",
    botId: "atlas",
    content: "\u001b]52;c;ZXZpbA==\u0007Visible reply",
    status: "completed",
    createdAt: snapshot.workspace.createdAt,
  });
  const actions: ConversationViewAction[] = [];
  const view = new ConversationView(
    "#general",
    "Shared decisions.",
    () => conversation,
    new Map([["atlas", "Atlas"]]),
    theme,
    (action) => actions.push(action),
    () => undefined,
  );

  const latestOutput = view.render(72).join("\n");
  assert.match(latestOutput, /Visible reply/);
  assert.equal(latestOutput.includes("\u001b]52"), false);
  for (let index = 0; index < 6; index += 1) view.handleInput("\u001b[5~");
  assert.match(view.render(72).join("\n"), /Message 0/);
  for (const width of [30, 72, 120])
    for (const line of view.render(width))
      assert.ok(visibleWidth(line) <= width);
  view.handleInput("\r");
  view.handleInput("\u001b");
  assert.deepEqual(actions, ["write", "close"]);
});

test("selection stays visible in long bot and channel lists", () => {
  const workspace = createWorkspace("Large", "/tmp/large");
  workspace.bots = Array.from({ length: 12 }, (_, index) => ({
    id: `bot-${index}`,
    name: `Bot ${index}`,
    role: "Reviewer",
    tools: [],
  })) as never;
  workspace.channels = Array.from({ length: 100 }, (_, index) => ({
    id: `channel-${index}`,
    name: `channel-${index}`,
    topic: "Topic",
    createdAt: workspace.createdAt,
  }));
  const output = renderDashboard(
    { workspace, engineReady: true },
    120,
    11,
  ).join("\n");
  assert.match(output, /> Bot 11/);
  assert.ok(output.split("\n").length < 20);
});
