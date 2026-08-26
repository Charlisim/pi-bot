import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import piBotExtension from "../src/extension.ts";
import { createWorkspace, loadWorkspace, saveWorkspace } from "../src/store.ts";
import type { BotProfile } from "../src/types.ts";

class FakeEvents {
  handlers = new Map<string, Set<(data: unknown) => void>>();
  emitted: Array<{ event: string; data: unknown }> = [];

  on(event: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  off(event: string, handler: (data: unknown) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, data: unknown): void {
    this.emitted.push({ event, data });
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }
}

const bot: BotProfile = {
  id: "atlas",
  name: "Atlas",
  role: "Reviewer",
  description: "Review changes.",
  personality: {
    summary: "Direct.",
    principles: "Use evidence.",
    boundaries: "Do not guess.",
  },
  instructions: "Review the request.",
  tools: [],
  modelPolicy: {
    preferred: "grok 4.6 high",
    fallback: [],
    thinking: "high",
  },
  channelIds: [],
  activation: { manual: true, mentions: true },
  inheritProjectContext: false,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const grok = {
  provider: "xai",
  id: "grok-4.6",
  name: "Grok 4.6",
  reasoning: true,
} as Model<Api>;

function fakeTheme() {
  return new Proxy(
    {},
    {
      get:
        () =>
        (...values: string[]) =>
          values.at(-1) ?? "",
    },
  );
}

test("legacy unavailable models cannot spawn or persist conversation input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bot-model-validation-"));
  process.env.PI_CODING_AGENT_DIR = root;
  const project = join(root, "project");
  const workspace = createWorkspace("Demo", project);
  workspace.bots.push(bot);
  await saveWorkspace(project, workspace);

  const events = new FakeEvents();
  events.on("subagents:rpc:v1:request", (value) => {
    const request = value as { requestId: string };
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: false,
      error: { code: "not_ready", message: "Test engine is offline" },
    });
  });
  const handlers = new Map<
    string,
    Array<(event: unknown, context: ExtensionContext) => unknown>
  >();
  let command:
    | ((args: string, context: ExtensionCommandContext) => Promise<void>)
    | undefined;
  const notifications: string[] = [];
  let dashboardCount = 0;
  const context = {
    cwd: project,
    mode: "tui",
    model: grok,
    thinkingLevel: "high",
    scopedModels: [],
    modelRegistry: { getAvailable: () => [grok] },
    sessionManager: { getEntries: () => [] },
    ui: {
      theme: fakeTheme(),
      notify: (message: string) => notifications.push(message),
      setWidget: () => {},
      setStatus: () => {},
      editor: async () => "Conversation input",
      custom: async (
        factory: (...args: unknown[]) => {
          constructor: { name: string };
          handleInput(data: string): void;
        },
      ) =>
        new Promise((resolve) => {
          const component = factory(
            { requestRender: () => {} },
            fakeTheme(),
            {},
            resolve,
          );
          if (component.constructor.name === "Dashboard") {
            dashboardCount += 1;
            component.handleInput(dashboardCount === 1 ? "\r" : "q");
          } else {
            component.handleInput("\r");
          }
        }),
    },
  } as unknown as ExtensionCommandContext;
  const extensionApi = {
    events,
    on: (
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    registerCommand: (
      name: string,
      definition: { handler: typeof command },
    ) => {
      if (name === "pi-bot") command = definition.handler;
    },
    registerShortcut: () => {},
    registerTool: () => {},
  };
  piBotExtension(extensionApi as never);
  for (const handler of handlers.get("session_start") ?? [])
    await handler({}, context);
  assert.ok(command);

  await command("run atlas Review this", context);
  await command("", context);

  const rpcMethods = events.emitted
    .filter((event) => event.event === "subagents:rpc:v1:request")
    .map((event) => (event.data as { method: string }).method);
  assert.equal(rpcMethods.includes("spawn"), false);
  assert.equal((await loadWorkspace(project))?.conversations.length, 0);
  assert.equal(
    notifications.filter((message) => message.includes("Unavailable bot model"))
      .length,
    2,
  );
});
