import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildRuntimeDefinition, serializeRuntimeAgent } from "../src/agent.ts";
import { createWorkspace, parseWorkspace } from "../src/store.ts";
import {
  applyTeamChange,
  archiveExpiredBots,
  descendantIds,
  restoreBot,
  TEAM_TOOL_NAMES,
} from "../src/team.ts";
import { TeamControlBridge } from "../src/team-control.ts";
import type { BotProfile } from "../src/types.ts";

const model = {
  provider: "xai",
  id: "grok-4.6",
  name: "Grok 4.6",
  reasoning: true,
} as Model<Api>;
const context = {
  scopedModels: [],
  modelRegistry: { getAvailable: () => [model] },
} as never;
function manager(id = "chief"): BotProfile {
  return {
    id,
    name: "Chief",
    role: "Chief of Staff",
    description: "Manage the team.",
    personality: {
      summary: "Direct.",
      principles: "Use evidence.",
      boundaries: "Respect caps.",
    },
    instructions: "Build the smallest suitable team.",
    tools: ["read", "grep"],
    modelPolicy: { preferred: "xai/grok-4.6", fallback: [], thinking: "high" },
    channelIds: [],
    activation: { manual: true, mentions: true },
    inheritProjectContext: false,
    status: "active",
    lifetime: { kind: "permanent" },
    management: {
      enabled: true,
      allowedProviders: ["xai"],
      allowedTools: ["read", "grep"],
      maxThinking: "high",
      maxDirectReports: 2,
      maxTeamSize: 3,
      maxDepth: 2,
    },
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("legacy state gains empty team data and active permanent bots", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  workspace.bots.push(manager());
  const raw = structuredClone(workspace) as unknown as Record<string, unknown>;
  delete raw.groups;
  delete raw.teamAudit;
  const bots = raw.bots as Array<Record<string, unknown>>;
  delete bots[0]?.status;
  delete bots[0]?.lifetime;
  delete bots[0]?.management;
  const parsed = parseWorkspace(raw);
  assert.deepEqual(parsed.groups, []);
  assert.deepEqual(parsed.teamAudit, []);
  assert.equal(parsed.bots[0]?.status, "active");
  assert.deepEqual(parsed.bots[0]?.lifetime, { kind: "permanent" });
});

test("team hiring enforces exact model, effort, tools, and monotonic caps", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  workspace.bots.push(manager());
  const hired = applyTeamChange(workspace, context, "chief", {
    action: "hire",
    name: "CTO",
    role: "CTO",
    purpose: "Lead engineering.",
    instructions: "Hire and coordinate engineers.",
    model: "xai/grok-4.6",
    thinking: "medium",
    tools: ["read"],
    canManageTeam: true,
    maxDirectReports: 2,
    maxTeamSize: 2,
    maxDepth: 1,
  });
  const cto = workspace.bots.find((bot) => bot.id === hired.targetId);
  assert.equal(cto?.parentId, "chief");
  assert.deepEqual(cto?.tools, ["read"]);
  assert.equal(cto?.management?.maxDepth, 1);
  assert.ok(descendantIds(workspace, "chief").has("cto"));
  assert.throws(
    () =>
      applyTeamChange(workspace, context, "chief", {
        action: "hire",
        name: "Bad",
        role: "Bad",
        purpose: "Bad model.",
        instructions: "No.",
        model: "openai/unknown",
        thinking: "high",
        tools: [],
      }),
    /outside the manager cap/,
  );
  assert.throws(
    () =>
      applyTeamChange(workspace, context, "cto", {
        action: "hire",
        name: "Bad Tool",
        role: "Dev",
        purpose: "Write.",
        instructions: "Write.",
        model: "xai/grok-4.6",
        thinking: "medium",
        tools: ["bash"],
      }),
    /tools exceed/,
  );
  assert.throws(
    () =>
      applyTeamChange(workspace, context, "cto", {
        action: "hire",
        name: "Too Deep",
        role: "Dev",
        purpose: "Deep.",
        instructions: "Deep.",
        model: "xai/grok-4.6",
        thinking: "medium",
        tools: [],
        canManageTeam: true,
        maxDepth: 2,
      }),
    /Team limit/,
  );
});

test("every ancestor subtree cap limits descendant hiring", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  const chief = manager();
  assert.ok(chief.management);
  chief.management = { ...chief.management, maxTeamSize: 3 };
  workspace.bots.push(chief);
  const managerResult = applyTeamChange(workspace, context, "chief", {
    action: "hire",
    name: "CTO",
    role: "CTO",
    purpose: "Lead engineering.",
    instructions: "Manage engineers.",
    model: "xai/grok-4.6",
    thinking: "medium",
    tools: [],
    canManageTeam: true,
    maxTeamSize: 2,
    maxDepth: 1,
  });
  applyTeamChange(workspace, context, "chief", {
    action: "hire",
    name: "Product",
    role: "Product",
    purpose: "Lead product.",
    instructions: "Plan product.",
    model: "xai/grok-4.6",
    thinking: "medium",
    tools: [],
  });
  applyTeamChange(workspace, context, managerResult.targetId, {
    action: "hire",
    name: "Frontend",
    role: "Frontend",
    purpose: "Build UI.",
    instructions: "Build UI.",
    model: "xai/grok-4.6",
    thinking: "low",
    tools: [],
  });
  assert.throws(
    () =>
      applyTeamChange(workspace, context, managerResult.targetId, {
        action: "hire",
        name: "Backend",
        role: "Backend",
        purpose: "Build APIs.",
        instructions: "Build APIs.",
        model: "xai/grok-4.6",
        thinking: "low",
        tools: [],
      }),
    /Chief subtree-size cap reached/,
  );
});

test("persisted descendants cannot widen inherited caps", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  workspace.bots.push(manager());
  applyTeamChange(workspace, context, "chief", {
    action: "hire",
    name: "CTO",
    role: "CTO",
    purpose: "Lead engineering.",
    instructions: "Manage engineers.",
    model: "xai/grok-4.6",
    thinking: "medium",
    tools: [],
    canManageTeam: true,
    maxDepth: 1,
  });
  const widened = structuredClone(workspace);
  const cto = widened.bots.find((bot) => bot.id === "cto");
  assert.ok(cto?.management);
  cto.management.allowedProviders.push("openai");
  assert.throws(() => parseWorkspace(widened), /caps must be monotonic/);
  const fallback = structuredClone(workspace);
  const fallbackCto = fallback.bots.find((bot) => bot.id === "cto");
  assert.ok(fallbackCto);
  fallbackCto.modelPolicy.fallback = ["openai/gpt-5"];
  assert.throws(() => parseWorkspace(fallback), /models must stay within/);
});

test("archive is descendant-only, preserves history, and supports restore and expiry", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  workspace.bots.push(manager(), { ...manager("peer"), management: undefined });
  applyTeamChange(workspace, context, "chief", {
    action: "hire",
    name: "Temp",
    role: "DevOps",
    purpose: "Temporary work.",
    instructions: "Finish once.",
    model: "xai/grok-4.6",
    thinking: "low",
    tools: [],
    temporaryHours: 1,
  });
  const temp = workspace.bots.find((bot) => bot.id === "temp");
  assert.ok(temp?.lifetime?.expiresAt);
  assert.throws(
    () =>
      applyTeamChange(workspace, context, "chief", {
        action: "archive",
        botId: "peer",
        reason: "No.",
      }),
    /descendants/,
  );
  workspace.runs.push({
    id: "run-1",
    botId: "temp",
    task: "Work",
    status: "completed",
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  });
  assert.deepEqual(
    archiveExpiredBots(
      workspace,
      new Date(Date.parse(temp.lifetime.expiresAt) + 1),
    ),
    ["temp"],
  );
  assert.equal(temp.status, "archived");
  assert.equal(workspace.runs.length, 1);
  restoreBot(workspace, "temp");
  assert.equal(temp.status, "active");
  assert.equal(temp.lifetime?.kind, "permanent");
});

test("expiring a temporary manager archives its active subtree", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  const chief = manager();
  chief.lifetime = {
    kind: "temporary",
    expiresAt: "2026-01-01T01:00:00.000Z",
  };
  workspace.bots.push(chief);
  applyTeamChange(workspace, context, "chief", {
    action: "hire",
    name: "CTO",
    role: "CTO",
    purpose: "Lead engineering.",
    instructions: "Lead engineering.",
    model: "xai/grok-4.6",
    thinking: "low",
    tools: [],
  });
  assert.deepEqual(
    new Set(
      archiveExpiredBots(workspace, new Date("2026-01-01T02:00:00.000Z")),
    ),
    new Set(["chief", "cto"]),
  );
  assert.ok(workspace.bots.every((bot) => bot.status === "archived"));
  assert.doesNotThrow(() => parseWorkspace(workspace));
});

test("manager runtime isolates team tools in its child-only extension", () => {
  const definition = buildRuntimeDefinition(manager());
  assert.deepEqual(definition.tools.slice(-4), [...TEAM_TOOL_NAMES]);
  assert.equal(definition.subagentOnlyExtensions.length, 1);
  const text = serializeRuntimeAgent(manager(), "/tmp/demo");
  assert.match(text, /subagentOnlyExtensions:/);
  assert.doesNotMatch(text, /tools:.*subagent(?:,|$)/);
  const worker = { ...manager("worker"), management: undefined };
  assert.equal(buildRuntimeDefinition(worker).subagentOnlyExtensions.length, 0);
});

test("team control binds bearer tokens to server-side actors", async () => {
  const seen: string[] = [];
  const bridge = new TeamControlBridge(async (actorId) => {
    seen.push(actorId);
    return { text: "ok" };
  });
  const issued = await bridge.issue("chief");
  const unauthorized = await fetch(issued.value.url, {
    method: "POST",
    headers: { authorization: `Bearer ${"0".repeat(64)}` },
    body: JSON.stringify({ action: "inspect", params: {} }),
  });
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(issued.value.url, {
    method: "POST",
    headers: { authorization: `Bearer ${issued.value.token}` },
    body: JSON.stringify({ action: "inspect", params: {} }),
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(seen, ["chief"]);
  issued.revoke();
  const revoked = await fetch(issued.value.url, {
    method: "POST",
    headers: { authorization: `Bearer ${issued.value.token}` },
    body: JSON.stringify({ action: "inspect", params: {} }),
  });
  assert.equal(revoked.status, 401);
  await bridge.close();
});
