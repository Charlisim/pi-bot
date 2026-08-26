import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderDashboard } from "../src/dashboard.ts";
import { createWorkspace } from "../src/store.ts";

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
