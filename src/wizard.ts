import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  botModelKey,
  defaultBotThinkingLevel,
  selectableBotModels,
  supportedBotThinkingLevels,
} from "./models.ts";
import { createBotId, createWorkspace, slugify } from "./store.ts";
import { validateToolName } from "./tools.ts";
import {
  type BotProfile,
  type Channel,
  THINKING_LEVELS,
  type ThinkingLevel,
  type Workspace,
} from "./types.ts";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const BUILDER_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

class Welcome implements Component {
  private readonly theme: Theme;
  private readonly done: (start: boolean) => void;

  constructor(theme: Theme, done: (start: boolean) => void) {
    this.theme = theme;
    this.done = done;
  }

  render(width: number): string[] {
    const content = [
      this.theme.fg(
        "accent",
        this.theme.bold("π·bot  /  build your own agent desk"),
      ),
      "",
      "Create specialists with their own role, personality, tools, and model policy.",
      "Pi Bot installs no default agents and runs nothing until you ask it to.",
      "",
      `${this.theme.fg("accent", "[Enter]")} Set up this workspace    ${this.theme.fg("muted", "[Esc] Return to Pi")}`,
    ];
    const border = `─`.repeat(Math.max(1, width - 2));
    return [
      `╭${border}╮`,
      ...content.map((line) => {
        const clipped = truncateToWidth(` ${line}`, width - 2, "…");
        return `│${clipped}${" ".repeat(Math.max(0, width - 2 - visibleWidth(clipped)))}│`;
      }),
      `╰${border}╯`,
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) this.done(true);
    if (matchesKey(data, Key.escape)) this.done(false);
  }

  invalidate(): void {}
}

async function askRequiredLine(
  ctx: ExtensionContext,
  title: string,
  placeholder: string,
  maxLength: number,
  current?: string,
): Promise<string | undefined> {
  const raw =
    current === undefined
      ? await ctx.ui.input(title, placeholder)
      : await ctx.ui.editor(title, current);
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value || value.includes("\n") || value.length > maxLength) {
    ctx.ui.notify(
      `${title} must be one non-empty line with at most ${maxLength} characters.`,
      "error",
    );
    return askRequiredLine(ctx, title, placeholder, maxLength, current);
  }
  return value;
}

async function askRequiredText(
  ctx: ExtensionContext,
  title: string,
  maxLength: number,
  prefill = "",
): Promise<string | undefined> {
  const raw = await ctx.ui.editor(title, prefill);
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value || value.length > maxLength) {
    ctx.ui.notify(
      `${title} must contain between 1 and ${maxLength} characters.`,
      "error",
    );
    return askRequiredText(ctx, title, maxLength, prefill);
  }
  return value;
}

function parseToolList(raw: string): string[] {
  const tools = [
    ...new Set(
      raw
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean),
    ),
  ];
  return tools.map(validateToolName);
}

async function chooseTools(
  ctx: ExtensionContext,
  current?: readonly string[],
  allowedTools?: readonly string[],
): Promise<string[] | undefined> {
  const allowed = allowedTools ? new Set(allowedTools) : undefined;
  const advisoryTools = READ_ONLY_TOOLS.filter(
    (tool) => !allowed || allowed.has(tool),
  );
  const builderTools = BUILDER_TOOLS.filter(
    (tool) => !allowed || allowed.has(tool),
  );
  const options = [
    "No tools — conversation only (Recommended)",
    ...(advisoryTools.length > 0
      ? [`Advisory — ${advisoryTools.join(", ")}`]
      : []),
    ...(builderTools.some((tool) => !READ_ONLY_TOOLS.includes(tool))
      ? ["Builder — permitted shell and workspace writes"]
      : []),
    "Custom — explicit built-in tool names",
  ];
  const choice = await ctx.ui.select("Choose an authority profile", options);
  if (choice === undefined) return undefined;
  if (choice.startsWith("No tools")) return [];
  if (choice.startsWith("Advisory")) return advisoryTools;
  if (choice.startsWith("Builder")) {
    const confirmed = await ctx.ui.confirm(
      "Grant workspace write access?",
      "Builder tools can run shell commands and modify files. Personality instructions cannot contain this authority.",
    );
    return confirmed ? builderTools : chooseTools(ctx, current, allowedTools);
  }
  const raw = await ctx.ui.input(
    "Comma-separated tool names",
    current?.join(", ") || "read, grep",
  );
  if (raw === undefined) return undefined;
  try {
    const tools = parseToolList(raw);
    if (allowed && tools.some((tool) => !allowed.has(tool)))
      throw new Error("Selected tools exceed the inherited manager cap.");
    const confirmed = await ctx.ui.confirm(
      "Grant these custom tools?",
      `${tools.join(", ") || "No tools"}\n\nAny tool outside the advisory set is treated as elevated.`,
    );
    return confirmed ? tools : chooseTools(ctx, current, allowedTools);
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
    return chooseTools(ctx, current, allowedTools);
  }
}

const MODEL_PAGE_SIZE = 10;
const PREVIOUS_MODELS = "← Previous 10 models";
const NEXT_MODELS = "Next 10 models →";

async function chooseModel(
  ctx: ExtensionContext,
  current?: string,
  allowedProviders?: readonly string[],
) {
  const models = selectableBotModels(ctx).filter(
    (model) => !allowedProviders || allowedProviders.includes(model.provider),
  );
  if (models.length === 0) {
    ctx.ui.notify(
      "Pi has no available models. Configure a provider or sign in first.",
      "error",
    );
    return undefined;
  }
  const currentPiModel = ctx.model ? botModelKey(ctx.model) : undefined;
  const saved = current
    ? models.find((model) => botModelKey(model) === current)
    : undefined;
  if (current && !saved)
    ctx.ui.notify(
      `Saved model ${current} is unavailable. Choose a replacement.`,
      "warning",
    );
  const initial =
    saved ??
    models.find((model) => botModelKey(model) === currentPiModel) ??
    models[0];
  if (!initial) return undefined;
  const providers = [...new Set(models.map((model) => model.provider))].sort();
  const orderedProviders = [
    initial.provider,
    ...providers.filter((provider) => provider !== initial.provider),
  ];
  const providerByLabel = new Map<string, string>(
    orderedProviders.map((provider) => {
      const count = models.filter(
        (model) => model.provider === provider,
      ).length;
      const marker =
        provider === saved?.provider
          ? " (saved)"
          : provider === ctx.model?.provider
            ? " (current Pi provider)"
            : "";
      return [`${provider} · ${count} models${marker}`, provider] as const;
    }),
  );
  const providerChoice = await ctx.ui.select("6/8 · Provider", [
    ...providerByLabel.keys(),
  ]);
  if (!providerChoice) return undefined;
  const provider = providerByLabel.get(providerChoice);
  if (!provider) return undefined;
  const providerModels = models.filter((model) => model.provider === provider);
  const selectedInitial =
    providerModels.find((model) => model === saved) ??
    providerModels.find((model) => botModelKey(model) === currentPiModel);
  let page = selectedInitial
    ? Math.floor(providerModels.indexOf(selectedInitial) / MODEL_PAGE_SIZE)
    : 0;
  const pageCount = Math.ceil(providerModels.length / MODEL_PAGE_SIZE);
  while (page >= 0 && page < pageCount) {
    const pageModels = providerModels.slice(
      page * MODEL_PAGE_SIZE,
      (page + 1) * MODEL_PAGE_SIZE,
    );
    const modelByLabel = new Map(
      pageModels.map((model) => {
        const key = botModelKey(model);
        const name = model.name === model.id ? "" : ` — ${model.name}`;
        const marker =
          key === current
            ? " (saved)"
            : key === currentPiModel
              ? " (current Pi model)"
              : "";
        return [`${model.id}${name}${marker}`, model] as const;
      }),
    );
    const options = [
      ...modelByLabel.keys(),
      ...(page > 0 ? [PREVIOUS_MODELS] : []),
      ...(page + 1 < pageCount ? [NEXT_MODELS] : []),
    ];
    const selected = await ctx.ui.select(
      `7/8 · Model · ${provider} · Page ${page + 1}/${pageCount}`,
      options,
    );
    if (!selected) return undefined;
    if (selected === PREVIOUS_MODELS) {
      page -= 1;
      continue;
    }
    if (selected === NEXT_MODELS) {
      page += 1;
      continue;
    }
    return modelByLabel.get(selected);
  }
  return undefined;
}

async function chooseThinking(
  ctx: ExtensionContext,
  model: ReturnType<typeof selectableBotModels>[number],
  requested: ThinkingLevel | undefined,
  maximum?: ThinkingLevel,
): Promise<ThinkingLevel | undefined> {
  const levels = supportedBotThinkingLevels(model).filter(
    (level) =>
      !maximum ||
      THINKING_LEVELS.indexOf(level) <= THINKING_LEVELS.indexOf(maximum),
  );
  const requestedLevel = defaultBotThinkingLevel(model, requested);
  const current = levels.includes(requestedLevel)
    ? requestedLevel
    : (levels.at(-1) ?? "off");
  const options = [
    `${current} (current)`,
    ...levels.filter((level) => level !== current),
  ];
  const selected = await ctx.ui.select("Reasoning effort", options);
  if (selected === undefined) return undefined;
  return selected.replace(" (current)", "") as ThinkingLevel;
}

export async function runOnboarding(
  ctx: ExtensionContext,
): Promise<Workspace | undefined> {
  if (ctx.mode === "tui") {
    const start = await ctx.ui.custom<boolean>(
      (_tui, theme, _keybindings, done) => new Welcome(theme, done),
    );
    if (!start) return undefined;
  }
  const suggestedName =
    ctx.cwd.split(/[\\/]/).filter(Boolean).at(-1) || "My workspace";
  const name = await askRequiredLine(ctx, "Workspace name", suggestedName, 80);
  if (!name) return undefined;
  return createWorkspace(name, ctx.cwd);
}

export async function runBotWizard(
  ctx: ExtensionContext,
  workspace: Workspace,
  existing?: BotProfile,
): Promise<BotProfile | undefined> {
  const name = await askRequiredLine(
    ctx,
    "1/8 · Bot name",
    "e.g. Atlas",
    80,
    existing?.name,
  );
  if (!name) return undefined;
  const role = await askRequiredLine(
    ctx,
    "2/8 · Role — what is this bot responsible for?",
    "e.g. Product strategist",
    120,
    existing?.role,
  );
  if (!role) return undefined;
  const description = await askRequiredText(
    ctx,
    "3/8 · Purpose — one clear outcome",
    500,
    existing?.description ?? "",
  );
  if (!description) return undefined;
  const personality = await askRequiredText(
    ctx,
    "4/8 · Personality — how should this bot communicate?",
    8_192,
    existing?.personality.summary ?? "",
  );
  if (!personality) return undefined;
  const principles = await askRequiredText(
    ctx,
    "Principles — how should it make decisions?",
    8_192,
    existing?.personality.principles ?? "",
  );
  if (!principles) return undefined;
  const boundaries = await askRequiredText(
    ctx,
    "Boundaries — what must it never do or assume?",
    8_192,
    existing?.personality.boundaries ?? "",
  );
  if (!boundaries) return undefined;
  const instructions = await askRequiredText(
    ctx,
    "5/8 · Operating instructions",
    8_192,
    existing?.instructions ?? "",
  );
  if (!instructions) return undefined;
  const parent = existing?.parentId
    ? workspace.bots.find((bot) => bot.id === existing.parentId)
    : undefined;
  const inherited = parent?.management?.enabled ? parent.management : undefined;
  const tools = await chooseTools(
    ctx,
    existing?.tools,
    inherited?.allowedTools,
  );
  if (!tools) return undefined;
  const model = await chooseModel(
    ctx,
    existing?.modelPolicy.preferred,
    inherited?.allowedProviders,
  );
  if (!model) return undefined;
  const modelKey = botModelKey(model);
  const requestedThinking =
    existing?.modelPolicy.thinking ??
    (ctx.model && botModelKey(ctx.model) === modelKey
      ? ctx.thinkingLevel
      : undefined);
  const thinking = await chooseThinking(
    ctx,
    model,
    requestedThinking,
    inherited?.maxThinking,
  );
  if (!thinking) return undefined;
  const manageTeam = await ctx.ui.confirm(
    "Allow this bot to manage a team?",
    "Managers can hire, group, archive, and delegate to descendants within inherited caps. Prompt text cannot expand these limits.",
  );
  const availableProviders = [
    ...new Set(selectableBotModels(ctx).map((item) => item.provider)),
  ];
  if (manageTeam && parent && !inherited) {
    ctx.ui.notify("The parent bot cannot delegate team management.", "error");
    return undefined;
  }
  const providerCap = inherited?.allowedProviders ?? availableProviders;
  const toolCap = inherited?.allowedTools ?? tools;
  const existingProviders =
    existing?.management?.allowedProviders ?? providerCap;
  const existingTools = existing?.management?.allowedTools ?? toolCap;
  const maxThinking = inherited
    ? (THINKING_LEVELS[
        Math.min(
          THINKING_LEVELS.indexOf(thinking),
          THINKING_LEVELS.indexOf(inherited.maxThinking),
        )
      ] ?? "off")
    : thinking;
  const management = manageTeam
    ? {
        enabled: true,
        allowedProviders: existingProviders.filter(
          (provider) =>
            availableProviders.includes(provider) &&
            providerCap.includes(provider),
        ),
        allowedTools: existingTools.filter((tool) => toolCap.includes(tool)),
        maxThinking,
        maxDirectReports: Math.min(
          existing?.management?.maxDirectReports ?? 5,
          inherited?.maxDirectReports ?? 100,
        ),
        maxTeamSize: Math.min(
          existing?.management?.maxTeamSize ?? 20,
          inherited ? Math.max(0, inherited.maxTeamSize - 1) : 100,
        ),
        maxDepth: Math.min(
          existing?.management?.maxDepth ?? 3,
          inherited ? Math.max(0, inherited.maxDepth - 1) : 10,
        ),
      }
    : undefined;
  const channelChoice = await ctx.ui.select("8/8 · Connect to a channel", [
    "No channel",
    ...workspace.channels.map((channel) => `#${channel.name}`),
  ]);
  if (channelChoice === undefined) return undefined;
  const selectedChannel = workspace.channels.find(
    (channel) => channel.name === channelChoice.slice(1),
  );
  const channelIds =
    channelChoice === "No channel"
      ? []
      : selectedChannel
        ? [selectedChannel.id]
        : [];
  const mentions = false;
  const inheritProjectContext = await ctx.ui.confirm(
    "Load trusted project instructions?",
    "This shares Pi's trusted project context with the bot. Repository content remains untrusted data and does not grant tools.",
  );
  const now = new Date().toISOString();
  const id = existing?.id ?? createBotId(name, workspace.bots);
  const candidate: BotProfile = {
    id,
    name,
    role,
    description,
    personality: { summary: personality, principles, boundaries },
    instructions,
    tools,
    modelPolicy: { preferred: modelKey, fallback: [], thinking },
    channelIds,
    activation: { manual: true, mentions },
    inheritProjectContext,
    ...(existing?.parentId ? { parentId: existing.parentId } : {}),
    ...(existing?.groupId ? { groupId: existing.groupId } : {}),
    status: existing?.status ?? "active",
    lifetime: existing?.lifetime ?? { kind: "permanent" },
    ...(management ? { management } : {}),
    version: existing ? existing.version + 1 : 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const summary = [
    `${candidate.name} · ${candidate.role}`,
    `ID: ${candidate.id}`,
    `Tools: ${candidate.tools.length > 0 ? candidate.tools.join(", ") : "none"}`,
    `Model: ${candidate.modelPolicy.preferred || "current Pi model"} · thinking ${candidate.modelPolicy.thinking}`,
    `Channels: ${candidate.channelIds.length > 0 ? candidate.channelIds.map((id) => `#${workspace.channels.find((channel) => channel.id === id)?.name ?? id}`).join(", ") : "none"}`,
    `Project context: ${candidate.inheritProjectContext ? "enabled" : "disabled"}`,
    `Team management: ${candidate.management?.enabled ? `${candidate.management.maxDirectReports} direct · ${candidate.management.maxTeamSize} team · depth ${candidate.management.maxDepth}` : "disabled"}`,
  ].join("\n");
  const save = await ctx.ui.confirm(
    existing ? "Save changes?" : "Create this bot?",
    summary,
  );
  return save ? candidate : undefined;
}

export async function runChannelWizard(
  ctx: ExtensionContext,
  workspace: Workspace,
): Promise<Channel | undefined> {
  const name = await askRequiredLine(ctx, "Channel name", "e.g. product", 80);
  if (!name) return undefined;
  const id = slugify(name);
  if (workspace.channels.some((channel) => channel.id === id)) {
    ctx.ui.notify(`Channel #${id} already exists.`, "error");
    return undefined;
  }
  const topic = await askRequiredText(ctx, "Channel topic", 500);
  if (!topic) return undefined;
  return { id, name: id, topic, createdAt: new Date().toISOString() };
}
