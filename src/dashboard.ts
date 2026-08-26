import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { classifyAuthority } from "./tools.ts";
import type {
  BotProfile,
  Conversation,
  RunRecord,
  WorkspaceSnapshot,
} from "./types.ts";

export type ConversationViewAction = "close" | "write";

export type DashboardAction =
  | { type: "create-bot" }
  | { type: "edit-bot"; botId: string }
  | { type: "delete-bot"; botId: string }
  | { type: "restore-bot"; botId: string }
  | { type: "run-bot"; botId: string }
  | { type: "inspect-bot"; botId: string }
  | { type: "inspect-channel"; channelId: string }
  | { type: "inspect-run"; runId: string }
  | { type: "create-channel" }
  | { type: "close" };

function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function line(
  left: string,
  middle: string,
  right: string,
  widths: [number, number, number],
): string {
  return `│${pad(left, widths[0])}│${pad(middle, widths[1])}│${pad(right, widths[2])}│`;
}

function botRow(
  bot: BotProfile,
  selected: boolean,
  theme: Theme,
  width: number,
): string {
  const marker = selected ? theme.fg("accent", ">") : " ";
  const safeName = stripTerminalSequences(bot.name);
  const name = selected
    ? theme.fg("accent", theme.bold(safeName))
    : theme.bold(safeName);
  const authority = classifyAuthority(bot.tools);
  const permission =
    authority === "elevated"
      ? theme.fg("warning", "elevated")
      : authority === "advisory"
        ? theme.fg("success", "advisory")
        : theme.fg("muted", "no tools");
  const state =
    (bot.status ?? "active") === "archived"
      ? theme.fg("warning", "archived")
      : bot.management?.enabled
        ? theme.fg("accent", "manager")
        : "";
  return truncateToWidth(
    `${marker} ${name}  ${theme.fg("muted", stripTerminalSequences(bot.role))}  ${permission}${state ? `  ${state}` : ""}`,
    width,
    "…",
  );
}

type DashboardColumn = "bots" | "channels" | "runs";

function itemWindow<T>(
  items: readonly T[],
  selected: number,
  limit: number,
): { start: number; items: readonly T[] } {
  const start = Math.min(
    Math.max(0, selected - limit + 1),
    Math.max(0, items.length - limit),
  );
  return { start, items: items.slice(start, start + limit) };
}

function panelTitle(
  label: string,
  column: DashboardColumn,
  selectedColumn: DashboardColumn,
  theme: Theme,
): string {
  return selectedColumn === column
    ? theme.fg("accent", theme.bold(label))
    : theme.fg("muted", label);
}

function channelRow(name: string, selected: boolean, theme: Theme): string {
  const safeName = stripTerminalSequences(name);
  return `${selected ? theme.fg("accent", ">") : " "} # ${selected ? theme.fg("accent", theme.bold(safeName)) : safeName}`;
}

function runRow(
  run: RunRecord,
  botName: string,
  selected: boolean,
  theme: Theme,
): string {
  const status = theme.fg(
    run.status === "failed"
      ? "error"
      : run.status === "completed"
        ? "success"
        : "warning",
    run.status,
  );
  return `${selected ? theme.fg("accent", ">") : " "} ${status}  ${stripTerminalSequences(botName)}`;
}

export function renderDashboard(
  snapshot: WorkspaceSnapshot,
  width: number,
  selectedBot = 0,
  theme?: Theme,
  selectedColumn: DashboardColumn = "bots",
  selectedChannel = 0,
  selectedRun = 0,
): string[] {
  const paint =
    theme ??
    ({
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme);
  if (width < 40) {
    const recentRuns = [...snapshot.workspace.runs].reverse();
    const bot = snapshot.workspace.bots[selectedBot];
    const channel = snapshot.workspace.channels[selectedChannel];
    const run = recentRuns[selectedRun];
    const selected =
      selectedColumn === "bots"
        ? bot
          ? `> ${stripTerminalSequences(bot.name)} · ${stripTerminalSequences(bot.role)}`
          : "> No bots"
        : selectedColumn === "channels"
          ? channel
            ? `> #${stripTerminalSequences(channel.name)}`
            : "> No channels"
          : run
            ? `> ${run.status} · ${run.id.slice(0, 8)}`
            : "> No runs";
    return [
      paint.fg("accent", paint.bold("π·bot")),
      `${snapshot.workspace.bots.length} bots · ${snapshot.workspace.runs.length} runs`,
      selected,
      "←→ panel · ↑↓ select · Enter open",
    ].map((line) => truncateToWidth(line, Math.max(1, width), "…"));
  }
  const inner = Math.max(1, width - 2);
  const top = `╭${"─".repeat(inner)}╮`;
  const bottom = `╰${"─".repeat(inner)}╯`;
  const engine = snapshot.engineReady
    ? paint.fg("success", "● engine ready")
    : paint.fg("warning", "! engine unavailable");
  const title = `${paint.fg("accent", paint.bold(" π·bot "))}${paint.fg("muted", `/ ${stripTerminalSequences(snapshot.workspace.name)}`)}`;
  const header = `│${pad(title, Math.max(1, inner - visibleWidth(engine) - 1))} ${engine}│`;
  const count = (value: number, singular: string) =>
    `${value} ${value === 1 ? singular : `${singular}s`}`;
  const stats = `│${pad(` ${count(snapshot.workspace.bots.length, "bot")}   ${count(snapshot.workspace.channels.length, "channel")}   ${count(snapshot.workspace.runs.length, "run")}`, inner)}│`;
  const divider = `├${"─".repeat(inner)}┤`;

  if (width < 92) {
    const bots = itemWindow(snapshot.workspace.bots, selectedBot, 4);
    const channels = itemWindow(
      snapshot.workspace.channels,
      selectedChannel,
      3,
    );
    const recentRuns = [...snapshot.workspace.runs].reverse();
    const runs = itemWindow(recentRuns, selectedRun, 3);
    const framed = (text: string) => `│${pad(` ${text}`, inner)}│`;
    return [
      top,
      header,
      stats,
      divider,
      framed(panelTitle("BOTS", "bots", selectedColumn, paint)),
      ...(bots.items.length
        ? bots.items.map((bot, index) =>
            framed(
              botRow(
                bot,
                selectedColumn === "bots" && bots.start + index === selectedBot,
                paint,
                inner - 2,
              ),
            ),
          )
        : [
            framed("Your agent desk is empty."),
            framed("Pi Bot installs no default agents. Press A to create one."),
          ]),
      framed(panelTitle("CHANNELS", "channels", selectedColumn, paint)),
      ...(channels.items.length
        ? channels.items.map((channel, index) =>
            framed(
              channelRow(
                channel.name,
                selectedColumn === "channels" &&
                  channels.start + index === selectedChannel,
                paint,
              ),
            ),
          )
        : [framed("No channels yet.")]),
      framed(panelTitle("RECENT RUNS", "runs", selectedColumn, paint)),
      ...(runs.items.length
        ? runs.items.map((run, index) => {
            const bot = snapshot.workspace.bots.find(
              (candidate) => candidate.id === run.botId,
            );
            return framed(
              runRow(
                run,
                bot?.name ?? run.botId,
                selectedColumn === "runs" && runs.start + index === selectedRun,
                paint,
              ),
            );
          })
        : [framed("No runs yet.")]),
      divider,
      framed("[←→] panel  [↑↓] select  [Enter] open run  [Esc] close"),
      bottom,
    ];
  }

  const separators = 2;
  const available = inner - separators;
  const leftWidth = Math.floor(available * 0.46);
  const middleWidth = Math.floor(available * 0.25);
  const rightWidth = available - leftWidth - middleWidth;
  const widths: [number, number, number] = [leftWidth, middleWidth, rightWidth];
  const panelDivider = `├${"─".repeat(leftWidth)}┼${"─".repeat(middleWidth)}┼${"─".repeat(rightWidth)}┤`;
  const bots = itemWindow(snapshot.workspace.bots, selectedBot, 9);
  const channels = itemWindow(snapshot.workspace.channels, selectedChannel, 9);
  const recentRuns = [...snapshot.workspace.runs].reverse();
  const runs = itemWindow(recentRuns, selectedRun, 9);
  const botRows = bots.items;
  const channelRows = channels.items;
  const runRows = runs.items;
  const rowCount = Math.max(
    6,
    botRows.length,
    channelRows.length,
    runRows.length,
  );
  const rows: string[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const bot = botRows[index];
    const channel = channelRows[index];
    const run = runRows[index];
    const runBot = run
      ? snapshot.workspace.bots.find((candidate) => candidate.id === run.botId)
      : undefined;
    const emptyBotMessage =
      snapshot.workspace.bots.length === 0
        ? index === 0
          ? " Your agent desk is empty."
          : index === 1
            ? " Pi Bot installs no default agents. Press A to create one."
            : ""
        : "";
    rows.push(
      line(
        bot
          ? ` ${botRow(
              bot,
              selectedColumn === "bots" && bots.start + index === selectedBot,
              paint,
              leftWidth - 2,
            )}`
          : emptyBotMessage,
        channel
          ? ` ${channelRow(
              channel.name,
              selectedColumn === "channels" &&
                channels.start + index === selectedChannel,
              paint,
            )}`
          : "",
        run
          ? ` ${runRow(
              run,
              runBot?.name ?? run.botId,
              selectedColumn === "runs" && runs.start + index === selectedRun,
              paint,
            )}`
          : "",
        widths,
      ),
    );
  }
  return [
    top,
    header,
    stats,
    panelDivider,
    line(
      ` ${panelTitle("BOTS", "bots", selectedColumn, paint)}`,
      ` ${panelTitle("CHANNELS", "channels", selectedColumn, paint)}`,
      ` ${panelTitle("RECENT RUNS", "runs", selectedColumn, paint)}`,
      widths,
    ),
    panelDivider,
    ...rows,
    panelDivider,
    line(
      ` ${paint.fg("accent", "[A]")} new  [R] run  [E] edit  [D] delete`,
      ` ${paint.fg("accent", "[C]")} new channel`,
      " [←→] panel  [↑↓] select  [Enter] open",
      widths,
    ),
    bottom,
  ];
}

export class Dashboard implements Component {
  private selectedColumn: DashboardColumn = "bots";
  private selectedBot = 0;
  private selectedChannel = 0;
  private selectedRun = 0;
  private readonly snapshot: WorkspaceSnapshot;
  private readonly theme: Theme;
  private readonly onAction: (action: DashboardAction) => void;
  private readonly requestRender: () => void;

  constructor(
    snapshot: WorkspaceSnapshot,
    theme: Theme,
    onAction: (action: DashboardAction) => void,
    requestRender: () => void,
  ) {
    this.snapshot = snapshot;
    this.theme = theme;
    this.onAction = onAction;
    this.requestRender = requestRender;
  }

  render(width: number): string[] {
    return renderDashboard(
      this.snapshot,
      width,
      this.selectedBot,
      this.theme,
      this.selectedColumn,
      this.selectedChannel,
      this.selectedRun,
    );
  }

  handleInput(data: string): void {
    const key = data.toLowerCase();
    const columns: DashboardColumn[] = ["bots", "channels", "runs"];
    if (
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.right) ||
      data === "h" ||
      data === "l"
    ) {
      const direction = matchesKey(data, Key.left) || data === "h" ? -1 : 1;
      const current = columns.indexOf(this.selectedColumn);
      this.selectedColumn =
        columns[(current + direction + columns.length) % columns.length] ??
        "bots";
      this.requestRender();
      return;
    }
    const counts = {
      bots: this.snapshot.workspace.bots.length,
      channels: this.snapshot.workspace.channels.length,
      runs: this.snapshot.workspace.runs.length,
    };
    const count = counts[this.selectedColumn];
    if ((matchesKey(data, Key.up) || data === "k") && count > 0) {
      this.moveSelection(-1, count);
      return;
    }
    if ((matchesKey(data, Key.down) || data === "j") && count > 0) {
      this.moveSelection(1, count);
      return;
    }
    if (key === "a") {
      this.onAction({ type: "create-bot" });
      return;
    }
    if (key === "c") {
      this.onAction({ type: "create-channel" });
      return;
    }
    if (matchesKey(data, Key.escape) || key === "q") {
      this.onAction({ type: "close" });
      return;
    }
    if (matchesKey(data, Key.enter) || key === "o") {
      if (this.selectedColumn === "bots") {
        const bot = this.snapshot.workspace.bots[this.selectedBot];
        if (bot) this.onAction({ type: "inspect-bot", botId: bot.id });
      } else if (this.selectedColumn === "channels") {
        const channel = this.snapshot.workspace.channels[this.selectedChannel];
        if (channel)
          this.onAction({ type: "inspect-channel", channelId: channel.id });
      } else {
        const run = [...this.snapshot.workspace.runs].reverse()[
          this.selectedRun
        ];
        if (run) this.onAction({ type: "inspect-run", runId: run.id });
      }
      return;
    }
    const bot = this.snapshot.workspace.bots[this.selectedBot];
    if (!bot) return;
    if (key === "r") this.onAction({ type: "run-bot", botId: bot.id });
    else if (key === "e") this.onAction({ type: "edit-bot", botId: bot.id });
    else if (key === "u" && (bot.status ?? "active") === "archived")
      this.onAction({ type: "restore-bot", botId: bot.id });
    else if (key === "d") this.onAction({ type: "delete-bot", botId: bot.id });
  }

  private moveSelection(direction: -1 | 1, count: number): void {
    const move = (selected: number) => (selected + direction + count) % count;
    if (this.selectedColumn === "bots")
      this.selectedBot = move(this.selectedBot);
    else if (this.selectedColumn === "channels")
      this.selectedChannel = move(this.selectedChannel);
    else this.selectedRun = move(this.selectedRun);
    this.requestRender();
  }

  invalidate(): void {}
}

interface DetailSection {
  label: string;
  text: string;
}

class DetailsView implements Component {
  private readonly title: string;
  private readonly summary: string;
  private readonly id: string;
  private readonly sections: readonly DetailSection[];
  private readonly theme: Theme;
  private readonly close: () => void;

  constructor(
    title: string,
    summary: string,
    id: string,
    sections: readonly DetailSection[],
    theme: Theme,
    close: () => void,
  ) {
    this.title = title;
    this.summary = summary;
    this.id = id;
    this.sections = sections;
    this.theme = theme;
    this.close = close;
  }

  render(width: number): string[] {
    if (width < 40)
      return [
        this.theme.fg(
          "accent",
          this.theme.bold(stripTerminalSequences(this.title)),
        ),
        stripTerminalSequences(this.summary),
        stripTerminalSequences(this.id),
        ...this.sections.flatMap((section) => [
          stripTerminalSequences(section.label),
          stripTerminalSequences(section.text),
        ]),
        "[Esc] back",
      ].map((line) => truncateToWidth(line, Math.max(1, width), "…"));
    const inner = width - 2;
    const frame = (text: string) => `│${pad(` ${text}`, inner)}│`;
    const wrapped = (text: string) =>
      wrapTextWithAnsi(text, Math.max(1, inner - 2)).map(frame);
    return [
      `╭${"─".repeat(inner)}╮`,
      frame(
        this.theme.fg(
          "accent",
          this.theme.bold(stripTerminalSequences(this.title)),
        ),
      ),
      frame(stripTerminalSequences(this.summary)),
      frame(stripTerminalSequences(this.id)),
      `├${"─".repeat(inner)}┤`,
      ...this.sections.flatMap((section, index) => [
        ...(index > 0 ? [frame("")] : []),
        frame(this.theme.fg("muted", stripTerminalSequences(section.label))),
        ...wrapped(stripTerminalSequences(section.text)),
      ]),
      `├${"─".repeat(inner)}┤`,
      frame("[Esc] back"),
      `╰${"─".repeat(inner)}╯`,
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data.toLowerCase() === "q")
      this.close();
  }

  invalidate(): void {}
}

export class RunDetails extends DetailsView {
  constructor(
    run: RunRecord,
    botName: string,
    runtimeDetails: string,
    theme: Theme,
    close: () => void,
  ) {
    super(
      "RUN DETAILS",
      `${botName} · ${run.status}`,
      run.id,
      [
        { label: "TASK", text: run.task },
        { label: "RUNTIME", text: runtimeDetails },
      ],
      theme,
      close,
    );
  }
}

export class ConversationView implements Component {
  private scrollOffset = 0;
  private maxScrollOffset = 0;
  private readonly title: string;
  private readonly subtitle: string;
  private readonly getConversation: () => Conversation | undefined;
  private readonly botNames: ReadonlyMap<string, string>;
  private readonly theme: Theme;
  private readonly onAction: (action: ConversationViewAction) => void;
  private readonly requestRender: () => void;

  constructor(
    title: string,
    subtitle: string,
    getConversation: () => Conversation | undefined,
    botNames: ReadonlyMap<string, string>,
    theme: Theme,
    onAction: (action: ConversationViewAction) => void,
    requestRender: () => void,
  ) {
    this.title = title;
    this.subtitle = subtitle;
    this.getConversation = getConversation;
    this.botNames = botNames;
    this.theme = theme;
    this.onAction = onAction;
    this.requestRender = requestRender;
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(1, width - (width < 40 ? 0 : 4));
    const messages = this.getConversation()?.messages ?? [];
    const messageLines = messages.flatMap((message) => {
      const author = stripTerminalSequences(
        message.author === "user"
          ? "YOU"
          : (this.botNames.get(message.botId ?? "") ?? message.botId ?? "BOT"),
      );
      const status =
        message.status === "pending"
          ? this.theme.fg("warning", " · thinking")
          : message.status === "failed"
            ? this.theme.fg("error", " · failed")
            : "";
      return [
        `${this.theme.fg(message.author === "user" ? "accent" : "success", this.theme.bold(author))}${status}`,
        ...wrapTextWithAnsi(stripTerminalSequences(message.content), bodyWidth),
        "",
      ];
    });
    if (messageLines.length === 0)
      messageLines.push("No messages yet. Press Enter to write.");
    const visibleCount = width < 40 ? 10 : 18;
    this.maxScrollOffset = Math.max(0, messageLines.length - visibleCount);
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset);
    const end = messageLines.length - this.scrollOffset;
    const visible = messageLines.slice(Math.max(0, end - visibleCount), end);
    const scrollHint = this.maxScrollOffset
      ? ` · ${this.scrollOffset}/${this.maxScrollOffset} lines back`
      : "";
    if (width < 40)
      return [
        this.theme.fg(
          "accent",
          this.theme.bold(stripTerminalSequences(this.title)),
        ),
        stripTerminalSequences(this.subtitle),
        ...visible,
        `[Enter] write · [↑↓] history${scrollHint}`,
        "[Esc] back",
      ].map((line) => truncateToWidth(line, Math.max(1, width), "…"));
    const inner = width - 2;
    const frame = (text: string) => `│${pad(` ${text}`, inner)}│`;
    return [
      `╭${"─".repeat(inner)}╮`,
      frame(
        this.theme.fg(
          "accent",
          this.theme.bold(stripTerminalSequences(this.title)),
        ),
      ),
      frame(stripTerminalSequences(this.subtitle)),
      `├${"─".repeat(inner)}┤`,
      ...visible.map(frame),
      `├${"─".repeat(inner)}┤`,
      frame(`[Enter] write  [↑↓/PgUp/PgDn] history${scrollHint}`),
      frame("[Esc] back"),
      `╰${"─".repeat(inner)}╯`,
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      this.onAction("write");
      return;
    }
    if (matchesKey(data, Key.escape) || data.toLowerCase() === "q") {
      this.onAction("close");
      return;
    }
    const previous = this.scrollOffset;
    if (matchesKey(data, Key.up) || data === "k")
      this.scrollOffset = Math.min(this.maxScrollOffset, this.scrollOffset + 1);
    else if (matchesKey(data, Key.down) || data === "j")
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    else if (matchesKey(data, Key.pageUp))
      this.scrollOffset = Math.min(
        this.maxScrollOffset,
        this.scrollOffset + 10,
      );
    else if (matchesKey(data, Key.pageDown))
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
    if (this.scrollOffset !== previous) this.requestRender();
  }

  invalidate(): void {}
}
