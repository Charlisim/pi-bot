import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  botModelKey,
  selectableBotModels,
  supportedBotThinkingLevels,
  unavailableBotModelIds,
} from "../src/models.ts";
import { createWorkspace } from "../src/store.ts";
import { runBotWizard } from "../src/wizard.ts";

function model(
  provider: string,
  id: string,
  options: {
    name?: string;
    reasoning?: boolean;
    thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  } = {},
): Model<Api> {
  return {
    provider,
    id,
    name: options.name ?? id,
    reasoning: options.reasoning ?? false,
    thinkingLevelMap: options.thinkingLevelMap,
  } as Model<Api>;
}

test("model choices honor session scope and model effort support", () => {
  const grok = model("xai", "grok-4.6", { reasoning: true });
  const fast = model("xai", "grok-4.6-fast");
  const context = {
    scopedModels: [{ model: fast }],
    modelRegistry: { getAvailable: () => [grok, fast] },
  } as unknown as ExtensionContext;

  assert.deepEqual(selectableBotModels(context).map(botModelKey), [
    "xai/grok-4.6-fast",
  ]);
  assert.deepEqual(supportedBotThinkingLevels(fast), ["off"]);
});

test("model pages expose at most ten models and continue on demand", async () => {
  const models = Array.from({ length: 23 }, (_, index) =>
    model("xai", `model-${String(index).padStart(2, "0")}`),
  );
  const modelPages: string[][] = [];
  const context = {
    cwd: "/tmp/demo",
    mode: "tui",
    model: models[0],
    thinkingLevel: "off",
    scopedModels: [],
    modelRegistry: { getAvailable: () => models },
    ui: {
      input: async (title: string) =>
        title.startsWith("1/8") ? "Atlas" : "Reviewer",
      editor: async (title: string) => title,
      select: async (title: string, options: string[]) => {
        if (title === "Choose an authority profile") return options[0];
        if (title === "6/8 · Provider") return options[0];
        if (title.startsWith("7/8 · Model")) {
          modelPages.push(options);
          if (modelPages.length < 3) return "Next 10 models →";
          return options.find((option) => option.startsWith("model-22"));
        }
        if (title === "Reasoning effort") return options[0];
        if (title.startsWith("8/8")) return "No channel";
        throw new Error(`Unexpected select: ${title}`);
      },
      confirm: async () => true,
      notify: () => {},
    },
  } as unknown as ExtensionContext;

  const bot = await runBotWizard(context, createWorkspace("Demo", context.cwd));

  assert.equal(bot?.modelPolicy.preferred, "xai/model-22");
  assert.equal(modelPages.length, 3);
  for (const page of modelPages)
    assert.ok(
      page.filter((option) => !option.includes("10 models")).length <= 10,
    );
});

test("bot setup stores an exact available model and supported effort", async () => {
  const grok = model("xai", "grok-4.6", {
    name: "Grok 4.6",
    reasoning: true,
    thinkingLevelMap: { xhigh: null, max: null },
  });
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const context = {
    cwd: "/tmp/demo",
    mode: "tui",
    model: grok,
    thinkingLevel: "high",
    scopedModels: [],
    modelRegistry: { getAvailable: () => [grok] },
    ui: {
      input: async (title: string) => {
        if (title.startsWith("1/8")) return "Atlas";
        if (title.startsWith("2/8")) return "Reviewer";
        if (title.startsWith("6/7")) return "grok 4.6 high";
        throw new Error(`Unexpected input: ${title}`);
      },
      editor: async (title: string) => title,
      select: async (title: string, options: string[]) => {
        selectCalls.push({ title, options });
        if (title === "Choose an authority profile") return options[0];
        if (title === "6/8 · Provider")
          return options.find((option) => option.startsWith("xai"));
        if (title.startsWith("7/8 · Model"))
          return options.find((option) => option.startsWith("grok-4.6"));
        if (title === "Reasoning effort") return "high";
        if (title.startsWith("8/8")) return "No channel";
        if (title === "Reasoning level") return "high";
        throw new Error(`Unexpected select: ${title}`);
      },
      confirm: async () => true,
      notify: () => {},
    },
  } as unknown as ExtensionContext;

  const bot = await runBotWizard(context, createWorkspace("Demo", context.cwd));

  assert.equal(bot?.modelPolicy.preferred, "xai/grok-4.6");
  assert.equal(bot?.modelPolicy.thinking, "high");
  assert.ok(selectCalls.some((call) => call.title === "6/8 · Provider"));
  const modelCall = selectCalls.find((call) =>
    call.title.startsWith("7/8 · Model"),
  );
  assert.ok(modelCall);
  assert.ok(modelCall.options.length <= 10);
  const effort = selectCalls.find((call) => call.title === "Reasoning effort");
  assert.ok(effort);
  assert.deepEqual(effort.options, [
    "high (current)",
    "off",
    "minimal",
    "low",
    "medium",
  ]);
  assert.ok(bot);
  assert.deepEqual(
    unavailableBotModelIds(context, [
      {
        ...bot,
        modelPolicy: {
          ...bot.modelPolicy,
          preferred: "grok 4.6 high",
        },
      },
    ]),
    ["grok 4.6 high"],
  );
});
