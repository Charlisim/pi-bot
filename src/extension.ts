import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runtimeAgentName } from "./agent.ts";
import { publishWorkspaceAgents, stageWorkspaceAgents } from "./agent-files.ts";
import {
  applyConversationReply,
  botProfileDigest,
  busyConversationRecipients,
  channelRecipients,
  channelTask,
  conversationContextRunId,
  conversationId,
  ensureConversation,
  findConversation,
  reconcileConversationRun,
} from "./conversations.ts";
import {
  ConversationView,
  type ConversationViewAction,
  Dashboard,
  type DashboardAction,
  RunDetails,
} from "./dashboard.ts";
import {
  loadWorkspace,
  MAX_ACTIVE_RUNS,
  prepareConversationResponse,
  readConversationResponse,
  removeConversationResponse,
  retainRuns,
  saveWorkspace,
} from "./store.ts";
import { type CompletionEvent, SubagentsClient } from "./subagents.ts";
import { classifyAuthority } from "./tools.ts";
import type {
  BotProfile,
  ConversationKind,
  RunRecord,
  Workspace,
  WorkspaceSnapshot,
} from "./types.ts";
import { runBotWizard, runChannelWizard, runOnboarding } from "./wizard.ts";

const WIDGET_KEY = "pi-bot";
const MAX_TASK_LENGTH = 8_192;

function cloneWorkspace(workspace: Workspace): Workspace {
  return structuredClone(workspace);
}

function parseCommand(args: string): { action: string; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "dashboard", rest: "" };
  const separator = trimmed.indexOf(" ");
  return separator === -1
    ? { action: trimmed.toLowerCase(), rest: "" }
    : {
        action: trimmed.slice(0, separator).toLowerCase(),
        rest: trimmed.slice(separator + 1).trim(),
      };
}

function parseRunArgs(rest: string): { botId: string; task?: string } {
  const separator = rest.indexOf(" ");
  if (separator === -1) return { botId: rest };
  return {
    botId: rest.slice(0, separator),
    task: rest.slice(separator + 1).trim(),
  };
}

export default function piBotExtension(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let workspace: Workspace | undefined;
  let mutationQueue: Promise<void> = Promise.resolve();
  let pendingRunReceipts = 0;
  let activeConversationRender: (() => void) | undefined;
  const earlyCompletions = new Map<string, CompletionEvent>();
  const pendingResponseIds = new Map<string, string>();
  const client = new SubagentsClient(pi.events);

  const updateSurface = () => {
    if (!ctx) return;
    if (!workspace) {
      ctx.ui.setStatus(
        WIDGET_KEY,
        ctx.ui.theme.fg("muted", "π·bot: not set up"),
      );
      ctx.ui.setWidget(
        WIDGET_KEY,
        ["π·bot  Your agent desk is empty. Run /pi-bot to begin."],
        { placement: "aboveEditor" },
      );
      return;
    }
    const activeRuns = workspace.runs.filter(
      (run) => run.status === "launched",
    ).length;
    ctx.ui.setStatus(
      WIDGET_KEY,
      ctx.ui.theme.fg(
        activeRuns > 0 ? "accent" : "muted",
        `π·bot: ${workspace.bots.length} bots · ${activeRuns} active`,
      ),
    );
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  };

  const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const persistWorkspace = async (candidate: Workspace) => {
    if (!ctx) throw new Error("Pi Bot has no active session.");
    candidate.runs = retainRuns(candidate.runs);
    const previous = workspace ? cloneWorkspace(workspace) : undefined;
    const botsChanged =
      !previous ||
      JSON.stringify(previous.bots) !== JSON.stringify(candidate.bots);
    if (!botsChanged) {
      await saveWorkspace(ctx.cwd, candidate);
      workspace = candidate;
      updateSurface();
      return;
    }
    const transaction = await stageWorkspaceAgents(candidate);
    await transaction.quarantine();
    try {
      await saveWorkspace(ctx.cwd, candidate);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    try {
      await transaction.activate();
    } catch (activationError) {
      if (previous) {
        try {
          await saveWorkspace(ctx.cwd, previous);
          await transaction.rollback();
          workspace = previous;
          updateSurface();
        } catch (rollbackError) {
          await transaction.finalize();
          workspace = candidate;
          updateSurface();
          throw new Error(
            `Runtime activation failed and rollback was incomplete. Profiles were left disabled: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      } else {
        await transaction.finalize();
        workspace = candidate;
        updateSurface();
      }
      throw new Error(
        `Runtime profile activation failed: ${activationError instanceof Error ? activationError.message : String(activationError)}`,
      );
    }
    workspace = candidate;
    updateSurface();
    await transaction.finalize();
  };

  const setWorkspace = (candidate: Workspace): Promise<void> =>
    serializeMutation(() => persistWorkspace(candidate));

  const mutateWorkspace = (
    mutate: (candidate: Workspace) => void,
  ): Promise<void> =>
    serializeMutation(async () => {
      if (!workspace) throw new Error("Pi Bot is not set up in this project.");
      const candidate = cloneWorkspace(workspace);
      mutate(candidate);
      await persistWorkspace(candidate);
    });

  const ensureWorkspace = async (): Promise<Workspace | undefined> => {
    if (workspace) return workspace;
    if (!ctx) return undefined;
    const created = await runOnboarding(ctx);
    if (!created) return undefined;
    await setWorkspace(created);
    const createFirst = await ctx.ui.confirm(
      "Create your first bot?",
      "The workspace is ready. Pi Bot still has no agents until you create one.",
    );
    if (createFirst) await createBot();
    return workspace;
  };

  const createBot = async (existing?: BotProfile) => {
    if (!ctx) return;
    const current = await ensureWorkspace();
    if (!current) return;
    const bot = await runBotWizard(ctx, current, existing);
    if (!bot) return;
    await mutateWorkspace((candidate) => {
      const index = candidate.bots.findIndex((item) => item.id === bot.id);
      if (index === -1) candidate.bots.push(bot);
      else candidate.bots[index] = bot;
    });
    ctx.ui.notify(`${bot.name} ${existing ? "updated" : "created"}.`, "info");
  };

  const deleteBot = async (botId: string) => {
    if (!ctx || !workspace) return;
    const bot = workspace.bots.find((item) => item.id === botId);
    if (!bot) throw new Error(`Unknown bot: ${botId}`);
    const confirmed = await ctx.ui.confirm(
      `Delete ${bot.name}?`,
      "The bot definition will be removed. Existing run receipts stay in history.",
    );
    if (!confirmed) return;
    await mutateWorkspace((candidate) => {
      candidate.bots = candidate.bots.filter((item) => item.id !== botId);
    });
    ctx.ui.notify(`${bot.name} deleted.`, "info");
  };

  const createChannel = async () => {
    if (!ctx) return;
    const current = await ensureWorkspace();
    if (!current) return;
    const channel = await runChannelWizard(ctx, current);
    if (!channel) return;
    await mutateWorkspace((candidate) => {
      candidate.channels.push(channel);
    });
    ctx.ui.notify(`#${channel.name} created.`, "info");
  };

  const assertRunCapacity = () => {
    if (
      workspace &&
      workspace.runs.filter((run) => run.status === "launched").length >=
        MAX_ACTIVE_RUNS
    )
      throw new Error(`At most ${MAX_ACTIVE_RUNS} runs can remain active.`);
  };

  const runBot = async (
    botId: string,
    providedTask?: string,
  ): Promise<string | undefined> => {
    if (!ctx || !workspace) return undefined;
    const bot = workspace.bots.find((item) => item.id === botId);
    if (!bot) throw new Error(`Unknown bot: ${botId}`);
    const taskInput =
      providedTask ?? (await ctx.ui.editor(`Task for ${bot.name}`, ""));
    const task = taskInput?.trim();
    if (!task) return undefined;
    if (task.length > MAX_TASK_LENGTH)
      throw new Error(`Task must be at most ${MAX_TASK_LENGTH} characters.`);
    if (classifyAuthority(bot.tools) === "elevated") {
      const confirmed = await ctx.ui.confirm(
        `Run ${bot.name} with elevated tools?`,
        `Tools: ${bot.tools.join(", ")}\n\nThese tools can have filesystem or process side effects.`,
      );
      if (!confirmed) return undefined;
    }
    assertRunCapacity();
    pendingRunReceipts += 1;
    let runId: string | undefined;
    try {
      runId = await client.spawn({
        agent: runtimeAgentName(workspace.projectPath, bot.id),
        task,
        cwd: ctx.cwd,
      });
      const launchedRunId = runId;
      const now = new Date().toISOString();
      const run: RunRecord = {
        id: launchedRunId,
        botId: bot.id,
        task,
        status: "launched",
        createdAt: now,
        updatedAt: now,
      };
      try {
        await mutateWorkspace((candidate) => {
          run.status =
            earlyCompletions.get(launchedRunId)?.status ?? "launched";
          earlyCompletions.delete(launchedRunId);
          candidate.runs.push(run);
        });
      } catch (error) {
        try {
          await client.stop(launchedRunId);
        } catch (stopError) {
          throw new Error(
            `Run ${launchedRunId} may still be active because its receipt could not be saved and stop failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
          );
        }
        throw error;
      }
      ctx.ui.notify(`${bot.name} launched · ${launchedRunId}`, "info");
      return launchedRunId;
    } finally {
      pendingRunReceipts -= 1;
      if (runId) earlyCompletions.delete(runId);
    }
  };

  const launchConversationReply = async (
    threadId: string,
    bot: BotProfile,
    task: string,
    runtimeTask: string,
  ): Promise<void> => {
    if (!ctx || !workspace) return;
    const conversation = workspace.conversations.find(
      (item) => item.id === threadId,
    );
    if (!conversation) throw new Error(`Unknown conversation: ${threadId}`);
    const profileDigest = botProfileDigest(bot);
    const storedContext = conversation.contexts.find(
      (context) => context.botId === bot.id,
    );
    const previousRunId = conversationContextRunId(conversation, bot);
    if (
      previousRunId &&
      workspace.runs.find((run) => run.id === previousRunId)?.status ===
        "launched"
    )
      throw new Error(`${bot.name} is still replying to the prior message.`);

    const projectPath = workspace.projectPath;
    const cwd = ctx.cwd;
    const responseId = randomUUID();
    const responsePath = await prepareConversationResponse(cwd, responseId);
    const spawn = (message: string) =>
      client.spawn({
        agent: runtimeAgentName(projectPath, bot.id),
        task: message,
        cwd,
        output: responsePath,
      });
    const lastUserIndex = conversation.messages.findLastIndex(
      (message) => message.author === "user",
    );
    const history = conversation.messages
      .slice(0, lastUserIndex)
      .filter(
        (message) =>
          message.status === "completed" &&
          (message.author === "user" || message.botId === bot.id),
      )
      .map(
        (message) =>
          `${message.author === "user" ? "User" : bot.name}: ${message.content}`,
      )
      .join("\n\n")
      .slice(-(64 * 1_024));
    const historyTask = history
      ? `Continue this existing conversation.\n\n${history}\n\n${runtimeTask}`
      : runtimeTask;
    assertRunCapacity();
    pendingRunReceipts += 1;
    let runId: string | undefined;
    try {
      runId =
        previousRunId && (await client.resumeAvailable(previousRunId))
          ? await client.resume(previousRunId, runtimeTask, responsePath)
          : await spawn(storedContext ? historyTask : runtimeTask);
      const launchedRunId = runId;
      pendingResponseIds.set(launchedRunId, responseId);
      const now = new Date().toISOString();
      let earlyCompletion: CompletionEvent | undefined;
      try {
        await mutateWorkspace((candidate) => {
          earlyCompletion = earlyCompletions.get(launchedRunId);
          const thread = candidate.conversations.find(
            (item) => item.id === threadId,
          );
          if (!thread) throw new Error(`Unknown conversation: ${threadId}`);
          const contextIndex = thread.contexts.findIndex(
            (context) => context.botId === bot.id,
          );
          const context = {
            botId: bot.id,
            runId: launchedRunId,
            profileDigest,
          };
          if (contextIndex === -1) thread.contexts.push(context);
          else thread.contexts[contextIndex] = context;
          thread.messages.push({
            id: randomUUID(),
            author: "bot",
            botId: bot.id,
            content: "Thinking…",
            status: "pending",
            runId: launchedRunId,
            responseId,
            createdAt: now,
          });
          thread.updatedAt = now;
          candidate.runs.push({
            id: launchedRunId,
            botId: bot.id,
            task,
            status: earlyCompletion?.status ?? "launched",
            createdAt: now,
            updatedAt: now,
          });
          earlyCompletions.delete(launchedRunId);
        });
        if (earlyCompletion) await handleCompletion(earlyCompletion);
      } catch (error) {
        try {
          await client.stop(launchedRunId);
        } catch (stopError) {
          throw new Error(
            `Run ${launchedRunId} may still be active because its receipt could not be saved and stop failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
          );
        }
        throw error;
      }
    } catch (error) {
      if (runId) pendingResponseIds.delete(runId);
      await removeConversationResponse(cwd, responseId);
      throw error;
    } finally {
      pendingRunReceipts -= 1;
      if (runId) earlyCompletions.delete(runId);
    }
  };

  const sendConversationMessage = async (
    kind: ConversationKind,
    targetId: string,
    input: string,
  ): Promise<void> => {
    if (!ctx || !workspace) return;
    const content = input.trim();
    if (!content) return;
    if (content.length > MAX_TASK_LENGTH)
      throw new Error(`Message must be at most ${MAX_TASK_LENGTH} characters.`);

    const bot =
      kind === "bot"
        ? workspace.bots.find((item) => item.id === targetId)
        : undefined;
    const channel =
      kind === "channel"
        ? workspace.channels.find((item) => item.id === targetId)
        : undefined;
    if (kind === "bot" && !bot) throw new Error(`Unknown bot: ${targetId}`);
    if (kind === "channel" && !channel)
      throw new Error(`Unknown channel: ${targetId}`);
    const recipients = bot
      ? [bot]
      : channelRecipients(workspace.bots, targetId, content);
    const busy = busyConversationRecipients(
      workspace,
      kind,
      targetId,
      recipients,
    );
    if (busy.length > 0)
      throw new Error(
        `Wait for the current reply from: ${busy.map((recipient) => recipient.name).join(", ")}.`,
      );
    const elevated = recipients.filter(
      (recipient) => classifyAuthority(recipient.tools) === "elevated",
    );
    if (elevated.length > 0) {
      const confirmed = await ctx.ui.confirm(
        "Send message to bots with elevated tools?",
        elevated.map((recipient) => recipient.name).join(", "),
      );
      if (!confirmed) return;
    }

    const now = new Date().toISOString();
    const threadId = conversationId(kind, targetId);
    await mutateWorkspace((candidate) => {
      const conversation = ensureConversation(candidate, kind, targetId, now);
      conversation.messages.push({
        id: randomUUID(),
        author: "user",
        content,
        status: "completed",
        createdAt: now,
      });
      conversation.updatedAt = now;
    });
    if (recipients.length === 0) {
      ctx.ui.notify(
        "Message saved. No bots are assigned to this channel.",
        "info",
      );
      return;
    }

    const runtimeTask = channel
      ? channelTask(channel.name, recipients.length, content)
      : content;
    for (const recipient of recipients) {
      try {
        await launchConversationReply(
          threadId,
          recipient,
          content,
          runtimeTask,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedAt = new Date().toISOString();
        await mutateWorkspace((candidate) => {
          const conversation = ensureConversation(
            candidate,
            kind,
            targetId,
            failedAt,
          );
          conversation.messages.push({
            id: randomUUID(),
            author: "bot",
            botId: recipient.id,
            content: message,
            status: "failed",
            createdAt: failedAt,
          });
          conversation.updatedAt = failedAt;
        });
        ctx.ui.notify(`${recipient.name}: ${message}`, "error");
      }
    }
  };

  const openConversation = async (
    kind: ConversationKind,
    targetId: string,
  ): Promise<void> => {
    if (!ctx || !workspace) return;
    if (ctx.mode !== "tui") {
      const conversation = findConversation(workspace, kind, targetId);
      const text = conversation?.messages
        .map((message) =>
          stripTerminalSequences(
            `${message.author === "user" ? "You" : message.botId}: ${message.content}`,
          ),
        )
        .join("\n\n");
      ctx.ui.notify(text || "No messages yet.", "info");
      return;
    }
    while (ctx && workspace) {
      const bot =
        kind === "bot"
          ? workspace.bots.find((item) => item.id === targetId)
          : undefined;
      const channel =
        kind === "channel"
          ? workspace.channels.find((item) => item.id === targetId)
          : undefined;
      if (kind === "bot" && !bot) throw new Error(`Unknown bot: ${targetId}`);
      if (kind === "channel" && !channel)
        throw new Error(`Unknown channel: ${targetId}`);
      const title = bot?.name ?? `#${channel?.name ?? targetId}`;
      const assigned = channel
        ? workspace.bots.filter((item) => item.channelIds.includes(channel.id))
        : [];
      const subtitle = bot
        ? `${bot.role} · ${bot.description}`
        : `${channel?.topic ?? ""}${assigned.length ? ` · ${assigned.map((item) => `@${item.id}`).join(", ")}` : " · no bots assigned"}`;
      const botNames = new Map(
        workspace.bots.map((item) => [item.id, item.name]),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      let action: ConversationViewAction | undefined;
      try {
        action = await ctx.ui.custom<ConversationViewAction>(
          (tui, theme, _keybindings, done) => {
            activeConversationRender = () => tui.requestRender();
            return new ConversationView(
              title,
              subtitle,
              () =>
                workspace
                  ? findConversation(workspace, kind, targetId)
                  : undefined,
              botNames,
              theme,
              done,
              () => tui.requestRender(),
            );
          },
        );
      } finally {
        activeConversationRender = undefined;
      }
      if (!action || action === "close") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const message = await ctx.ui.editor(`Message ${title}`, "");
      if (message?.trim())
        await sendConversationMessage(kind, targetId, message);
    }
  };

  const inspectRun = async (runId: string) => {
    if (!ctx || !workspace) return;
    const run = workspace.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const bot = workspace.bots.find((item) => item.id === run.botId);
    let runtimeDetails: string;
    try {
      runtimeDetails = await client.inspect(runId);
    } catch (error) {
      runtimeDetails = `Live runtime details are unavailable. Saved receipt status: ${run.status}. ${error instanceof Error ? error.message : String(error)}`;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.notify(`${run.id}\n${run.task}\n\n${runtimeDetails}`, "info");
      return;
    }
    await ctx.ui.custom<void>(
      (_tui, theme, _keybindings, done) =>
        new RunDetails(run, bot?.name ?? run.botId, runtimeDetails, theme, () =>
          done(undefined),
        ),
    );
  };

  const handleCompletion = async (event: CompletionEvent) => {
    if (!ctx) return;
    const responseId =
      pendingResponseIds.get(event.runId) ??
      workspace?.conversations
        .flatMap((conversation) => conversation.messages)
        .find((message) => message.runId === event.runId)?.responseId;
    let completion = event;
    let updated = false;
    try {
      if (responseId) {
        const output = await readConversationResponse(ctx.cwd, responseId);
        if (output) completion = { ...event, output };
      }
      await serializeMutation(async () => {
        if (!workspace) return;
        const index = workspace.runs.findIndex((run) => run.id === event.runId);
        if (index === -1) {
          if (pendingRunReceipts > 0) earlyCompletions.set(event.runId, event);
          return;
        }
        const candidate = cloneWorkspace(workspace);
        const currentRun = candidate.runs[index];
        if (!currentRun) return;
        const now = new Date().toISOString();
        candidate.runs[index] = {
          ...currentRun,
          status: event.status,
          updatedAt: now,
        };
        applyConversationReply(candidate, completion, now);
        await persistWorkspace(candidate);
        updated = true;
      });
      if (updated) {
        if (responseId) {
          await removeConversationResponse(ctx.cwd, responseId);
          pendingResponseIds.delete(event.runId);
        }
        activeConversationRender?.();
        ctx.ui.notify(
          `Run ${event.runId} ${event.status}.`,
          event.status === "failed" ? "error" : "info",
        );
      }
    } catch (error) {
      ctx.ui.notify(
        `Could not save completion for ${event.runId}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };

  const openDashboard = async () => {
    if (!ctx) return;
    if (!(await ensureWorkspace())) return;
    if (ctx.mode !== "tui") {
      ctx.ui.notify(
        "The dashboard requires Pi TUI mode. Use /pi-bot status or /pi-bot new in RPC mode.",
        "warning",
      );
      return;
    }
    let open = true;
    while (open && workspace) {
      const snapshot: WorkspaceSnapshot = {
        workspace,
        engineReady: client.isReady(),
      };
      const action = await ctx.ui.custom<DashboardAction>(
        (tui, theme, _keybindings, done) =>
          new Dashboard(snapshot, theme, done, () => tui.requestRender()),
      );
      if (!action || action.type === "close") break;
      try {
        if (action.type === "create-bot") await createBot();
        else if (action.type === "edit-bot")
          await createBot(
            workspace.bots.find((bot) => bot.id === action.botId),
          );
        else if (action.type === "delete-bot") await deleteBot(action.botId);
        else if (action.type === "create-channel") await createChannel();
        else if (action.type === "run-bot") await runBot(action.botId);
        else if (action.type === "inspect-bot")
          await openConversation("bot", action.botId);
        else if (action.type === "inspect-channel")
          await openConversation("channel", action.channelId);
        else if (action.type === "inspect-run") await inspectRun(action.runId);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
      open = Boolean(workspace);
    }
  };

  client.onCompletion((event) => {
    void handleCompletion(event);
  });

  pi.on("session_start", async (_event, context) => {
    ctx = context;
    try {
      workspace = await loadWorkspace(context.cwd);
    } catch (error) {
      workspace = undefined;
      context.ui.notify(
        `Pi Bot could not load saved state: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      updateSurface();
      return;
    }
    if (workspace?.bots.length) {
      try {
        await publishWorkspaceAgents(workspace);
      } catch (error) {
        context.ui.notify(
          `Pi Bot could not activate saved runtime profiles: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    }
    const engineReady = await client.probe();
    if (workspace?.runs.some((run) => run.status === "launched")) {
      try {
        const statuses = engineReady ? await client.statuses() : new Map();
        const recovered = new Map<
          string,
          { responseId: string; output: string }
        >();
        for (const conversation of workspace.conversations) {
          for (const message of conversation.messages) {
            if (
              message.status !== "pending" ||
              !message.runId ||
              !message.responseId
            )
              continue;
            const output = await readConversationResponse(
              context.cwd,
              message.responseId,
            );
            if (output)
              recovered.set(message.runId, {
                responseId: message.responseId,
                output,
              });
          }
        }
        await serializeMutation(async () => {
          if (!workspace) return;
          const candidate = cloneWorkspace(workspace);
          let changed = false;
          for (const run of candidate.runs) {
            const recovery = recovered.get(run.id);
            const status = statuses.get(run.id) ?? "unknown";
            changed =
              reconcileConversationRun(
                candidate,
                run.id,
                status,
                recovery?.output,
                new Date().toISOString(),
              ) || changed;
          }
          if (changed) {
            await saveWorkspace(context.cwd, candidate);
            workspace = candidate;
          }
        });
        for (const recovery of recovered.values())
          await removeConversationResponse(context.cwd, recovery.responseId);
      } catch (error) {
        context.ui.notify(
          `Pi Bot could not reconcile prior runs. Saved bots remain available: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }
    updateSurface();
  });

  pi.on("session_shutdown", async () => {
    await mutationQueue;
    ctx?.ui.setStatus(WIDGET_KEY, undefined);
    ctx?.ui.setWidget(WIDGET_KEY, undefined);
    client.dispose();
    ctx = undefined;
  });

  pi.registerCommand("pi-bot", {
    description: "Open Pi Bot or manage custom bots",
    getArgumentCompletions: (prefix) => {
      const actions = [
        "status",
        "list",
        "new",
        "edit",
        "delete",
        "run",
        "inspect",
        "channel",
      ];
      return actions
        .filter((action) => action.startsWith(prefix))
        .map((action) => ({ value: action, label: action }));
    },
    handler: async (args, context) => {
      ctx = context;
      const command = parseCommand(args);
      try {
        if (command.action === "dashboard") await openDashboard();
        else if (command.action === "status") {
          const current = await ensureWorkspace();
          if (current)
            context.ui.notify(
              `${current.name}: ${current.bots.length} bots, ${current.channels.length} channels, ${current.runs.length} runs.`,
              "info",
            );
        } else if (command.action === "list") {
          const current = await ensureWorkspace();
          const bots = current?.bots
            .map((bot) => `${bot.id}: ${bot.name} — ${bot.role}`)
            .join("\n");
          context.ui.notify(
            bots || "No bots yet. Run /pi-bot new to create one.",
            "info",
          );
        } else if (command.action === "new") await createBot();
        else if (command.action === "channel") await createChannel();
        else if (command.action === "edit") {
          const current = await ensureWorkspace();
          const bot = current?.bots.find((item) => item.id === command.rest);
          if (!bot) throw new Error("Usage: /pi-bot edit <bot-id>");
          await createBot(bot);
        } else if (command.action === "delete") await deleteBot(command.rest);
        else if (command.action === "run") {
          const parsed = parseRunArgs(command.rest);
          if (!parsed.botId)
            throw new Error("Usage: /pi-bot run <bot-id> [task]");
          await runBot(parsed.botId, parsed.task);
        } else if (command.action === "inspect") {
          if (!command.rest) throw new Error("Usage: /pi-bot inspect <run-id>");
          await inspectRun(command.rest);
        } else throw new Error(`Unknown Pi Bot action: ${command.action}`);
      } catch (error) {
        context.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.registerShortcut("ctrl+shift+b", {
    description: "Open Pi Bot",
    handler: async (context) => {
      ctx = context;
      await openDashboard();
    },
  });

  pi.registerTool({
    name: "pi_bot",
    label: "Pi Bot",
    description:
      "List user-created Pi Bot agents or launch one after human confirmation",
    promptSnippet: "List or run user-created Pi Bot agents",
    promptGuidelines: [
      "Use pi_bot only when the user asks to inspect or run a bot created in Pi Bot.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "run"] as const),
      botId: Type.Optional(Type.String()),
      task: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      ctx = context;
      if (!workspace)
        throw new Error(
          "Pi Bot is not set up in this project. Run /pi-bot first.",
        );
      if (params.action === "list") {
        const text =
          workspace.bots.length === 0
            ? "No bots exist. Pi Bot ships with no default agents."
            : workspace.bots
                .map((bot) => `${bot.id}: ${bot.name} — ${bot.role}`)
                .join("\n");
        return {
          content: [{ type: "text", text }],
          details: { count: workspace.bots.length },
        };
      }
      if (!params.botId || !params.task)
        throw new Error("pi_bot run requires botId and task.");
      if (!context.hasUI)
        throw new Error(
          "pi_bot run requires an interactive human confirmation.",
        );
      const confirmed = await context.ui.confirm(
        "Launch Pi Bot agent?",
        `${params.botId}: ${params.task}`,
      );
      if (!confirmed)
        return {
          content: [{ type: "text", text: "Launch cancelled by the user." }],
          details: { cancelled: true },
        };
      const runId = await runBot(params.botId, params.task);
      return {
        content: [
          {
            type: "text",
            text: runId
              ? `Launched ${params.botId}: ${runId}`
              : "Launch cancelled.",
          },
        ],
        details: { runId },
      };
    },
  });
}
