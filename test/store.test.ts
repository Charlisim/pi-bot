import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createBotId,
  createWorkspace,
  loadWorkspace,
  parseWorkspace,
  prepareConversationResponse,
  readConversationResponse,
  removeConversationResponse,
  retainRuns,
  saveWorkspace,
  slugify,
  workspacePath,
} from "../src/store.ts";
import type { RunRecord } from "../src/types.ts";

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-bot-test-"));
}

test("a new workspace contains no default agents", () => {
  const workspace = createWorkspace(
    "Demo",
    "/tmp/demo",
    new Date("2026-01-01T00:00:00.000Z"),
  );
  assert.deepEqual(workspace.bots, []);
  assert.equal(workspace.channels.length, 1);
  assert.equal(workspace.channels[0]?.id, "general");
  assert.deepEqual(workspace.conversations, []);
});

test("legacy workspaces gain empty conversations and messages persist", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  const legacy = { ...workspace } as Partial<typeof workspace>;
  delete legacy.conversations;
  assert.deepEqual(parseWorkspace(legacy).conversations, []);

  workspace.conversations.push({
    id: "channel:general",
    kind: "channel",
    targetId: "general",
    messages: [
      {
        id: "message-1",
        author: "user",
        content: "Hello team",
        status: "completed",
        createdAt: workspace.createdAt,
      },
      {
        id: "message-2",
        author: "bot",
        botId: "atlas",
        content: "Hello",
        status: "completed",
        runId: "run-1",
        createdAt: workspace.createdAt,
      },
    ],
    contexts: [{ botId: "atlas", runId: "run-1" }],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  });
  assert.deepEqual(
    parseWorkspace(workspace).conversations,
    workspace.conversations,
  );
});

test("workspace state is stored outside the project with restrictive permissions", async () => {
  const root = await temporaryRoot();
  const workspace = createWorkspace("Demo", "/tmp/project");
  await saveWorkspace("/tmp/project", workspace, root);
  const path = workspacePath("/tmp/project", root);
  const contents = await readFile(path, "utf8");
  assert.equal(JSON.parse(contents).bots.length, 0);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(
    await loadWorkspace("/tmp/project", root),
    parseWorkspace(JSON.parse(contents)),
  );
});

test("conversation response files are private and recoverable", async () => {
  const root = await temporaryRoot();
  const responseId = "00000000-0000-4000-8000-000000000001";
  const path = await prepareConversationResponse(
    "/tmp/project",
    responseId,
    root,
  );
  await writeFile(path, "Final\0response", { mode: 0o644 });
  assert.equal(
    await readConversationResponse("/tmp/project", responseId, root),
    "Final�response",
  );
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await removeConversationResponse("/tmp/project", responseId, root);
  assert.equal(
    await readConversationResponse("/tmp/project", responseId, root),
    undefined,
  );
  const outside = join(root, "outside-response.txt");
  await writeFile(outside, "unsafe");
  await symlink(outside, path);
  await assert.rejects(
    readConversationResponse("/tmp/project", responseId, root),
    /regular file/,
  );
});

test("run retention preserves active completion receipts", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  const runs = [
    {
      id: "active-old",
      botId: "atlas",
      task: "Still running",
      status: "launched",
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    },
    ...Array.from({ length: 120 }, (_, index) => ({
      id: `done-${index}`,
      botId: "atlas",
      task: `Done ${index}`,
      status: "completed",
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    })),
  ] as RunRecord[];
  const activeTemplate = runs[0];
  assert.ok(activeTemplate);
  const retained = retainRuns(runs);
  assert.equal(retained.length, 100);
  assert.ok(retained.some((run) => run.id === "active-old"));
  assert.ok(!retained.some((run) => run.id === "done-0"));
  assert.throws(
    () =>
      retainRuns(
        Array.from({ length: 101 }, (_, index) => ({
          ...activeTemplate,
          id: `active-${index}`,
        })) as never,
      ),
    /100 runs can remain active/,
  );
});

test("missing state does not create files or agents", async () => {
  const root = await temporaryRoot();
  assert.equal(await loadWorkspace("/tmp/missing", root), undefined);
});

test("linked state roots fail closed", async () => {
  const parent = await temporaryRoot();
  const target = join(parent, "target");
  const linkedRoot = join(parent, "linked");
  await mkdir(target);
  await symlink(target, linkedRoot);
  await assert.rejects(
    saveWorkspace(
      "/tmp/project",
      createWorkspace("Demo", "/tmp/project"),
      linkedRoot,
    ),
    /state root/,
  );
});

test("linked state files fail closed", async () => {
  const root = await temporaryRoot();
  const path = workspacePath("/tmp/project", root);
  await mkdir(join(path, ".."), { recursive: true });
  const target = join(root, "outside.json");
  await writeFile(
    target,
    JSON.stringify(createWorkspace("Demo", "/tmp/project")),
  );
  await symlink(target, path);
  await assert.rejects(loadWorkspace("/tmp/project", root), /regular file/);
});

test("invalid and cross-channel state fails closed", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  assert.throws(
    () => parseWorkspace({ ...workspace, schemaVersion: 2 }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      parseWorkspace({
        ...workspace,
        channels: [...workspace.channels, workspace.channels[0]],
      }),
    /unique/,
  );
  assert.throws(
    () => parseWorkspace({ ...workspace, bots: [{ id: "bad" }] }),
    /must be/,
  );
});

test("IDs are stable ASCII slugs and collisions receive a bounded suffix", () => {
  assert.equal(slugify("Áccounting Advisor"), "accounting-advisor");
  assert.equal(createBotId("Scout", [{ id: "scout" } as never]), "scout-2");
  const long = "a".repeat(64);
  assert.equal(createBotId(long, [{ id: long } as never]).length, 64);
  assert.throws(() => slugify("---"), /letter or number/);
});

test("corrupt tool authority cannot inject frontmatter or recursion", () => {
  const workspace = createWorkspace("Demo", "/tmp/demo");
  const baseBot = {
    id: "atlas",
    name: "Atlas",
    role: "Advisor",
    description: "Advise.",
    personality: {
      summary: "Direct.",
      principles: "Use evidence.",
      boundaries: "Do not guess.",
    },
    instructions: "Answer directly.",
    tools: ["read"],
    modelPolicy: { fallback: [], thinking: "off" },
    channelIds: ["general"],
    activation: { manual: true, mentions: false },
    inheritProjectContext: false,
    version: 1,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
  assert.throws(
    () =>
      parseWorkspace({
        ...workspace,
        bots: [
          { ...baseBot, tools: ["read\nsubagentOnlyExtensions: /tmp/evil.ts"] },
        ],
      }),
    /Invalid tool name/,
  );
  assert.throws(
    () =>
      parseWorkspace({
        ...workspace,
        bots: [{ ...baseBot, tools: ["subagent"] }],
      }),
    /does not grant recursive/,
  );
  assert.throws(
    () =>
      parseWorkspace({ ...workspace, bots: [{ ...baseBot, id: "../escape" }] }),
    /lowercase ASCII slug/,
  );
  assert.throws(
    () =>
      parseWorkspace({
        ...workspace,
        bots: [{ ...baseBot, id: "atlas\ntools-bash" }],
      }),
    /lowercase ASCII slug/,
  );
  assert.throws(
    () =>
      parseWorkspace({
        ...workspace,
        bots: [{ ...baseBot, tools: ["unknown_network_tool"] }],
      }),
    /Unsupported tool/,
  );
});
