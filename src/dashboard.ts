import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { classifyAuthority } from "./tools.ts";
import type { BotProfile, WorkspaceSnapshot } from "./types.ts";

export type DashboardAction =
  | { type: "create-bot" }
  | { type: "edit-bot"; botId: string }
  | { type: "delete-bot"; botId: string }
  | { type: "run-bot"; botId: string }
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
  const name = selected
    ? theme.fg("accent", theme.bold(bot.name))
    : theme.bold(bot.name);
  const authority = classifyAuthority(bot.tools);
  const permission =
    authority === "elevated"
      ? theme.fg("warning", "elevated")
      : authority === "advisory"
        ? theme.fg("success", "advisory")
        : theme.fg("muted", "no tools");
  return truncateToWidth(
    `${marker} ${name}  ${theme.fg("muted", bot.role)}  ${permission}`,
    width,
    "…",
  );
}

function botWindow(
  bots: readonly BotProfile[],
  selected: number,
  limit: number,
): { start: number; bots: readonly BotProfile[] } {
  const start = Math.min(
    Math.max(0, selected - limit + 1),
    Math.max(0, bots.length - limit),
  );
  return { start, bots: bots.slice(start, start + limit) };
}

export function renderDashboard(
  snapshot: WorkspaceSnapshot,
  width: number,
  selectedBot = 0,
  theme?: Theme,
): string[] {
  const paint =
    theme ??
    ({
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme);
  if (width < 40) {
    const selected = snapshot.workspace.bots[selectedBot];
    return [
      paint.fg("accent", paint.bold("π·bot")),
      `${snapshot.workspace.bots.length} bots · ${snapshot.workspace.runs.length} runs`,
      selected
        ? `> ${selected.name} · ${selected.role}`
        : "No bots yet. Press A to create one.",
      "A new · R run · Esc close",
    ].map((line) => truncateToWidth(line, Math.max(1, width), "…"));
  }
  const inner = Math.max(1, width - 2);
  const top = `╭${"─".repeat(inner)}╮`;
  const bottom = `╰${"─".repeat(inner)}╯`;
  const engine = snapshot.engineReady
    ? paint.fg("success", "● engine ready")
    : paint.fg("warning", "! engine unavailable");
  const title = `${paint.fg("accent", paint.bold(" π·bot "))}${paint.fg("muted", `/ ${snapshot.workspace.name}`)}`;
  const header = `│${pad(title, Math.max(1, inner - visibleWidth(engine) - 1))} ${engine}│`;
  const count = (value: number, singular: string) =>
    `${value} ${value === 1 ? singular : `${singular}s`}`;
  const stats = `│${pad(` ${count(snapshot.workspace.bots.length, "bot")}   ${count(snapshot.workspace.channels.length, "channel")}   ${count(snapshot.workspace.runs.length, "run")}`, inner)}│`;
  const divider = `├${"─".repeat(inner)}┤`;

  if (snapshot.workspace.bots.length === 0) {
    return [
      top,
      header,
      stats,
      divider,
      `│${pad("", inner)}│`,
      `│${pad(` ${paint.fg("accent", paint.bold("Your agent desk is empty."))}`, inner)}│`,
      `│${pad(" Pi Bot installs no default agents and runs nothing until you create one.", inner)}│`,
      `│${pad("", inner)}│`,
      `│${pad(` ${paint.fg("accent", "[A]")} Create your first bot    ${paint.fg("muted", "[C] channel  [Esc] close")}`, inner)}│`,
      `│${pad("", inner)}│`,
      bottom,
    ];
  }

  if (width < 92) {
    const window = botWindow(snapshot.workspace.bots, selectedBot, 8);
    const rows = window.bots.map(
      (bot, index) =>
        `│${pad(` ${botRow(bot, window.start + index === selectedBot, paint, inner - 2)}`, inner)}│`,
    );
    const recent = snapshot.workspace.runs
      .slice(-3)
      .reverse()
      .map((run) => {
        const bot = snapshot.workspace.bots.find(
          (candidate) => candidate.id === run.botId,
        );
        return `│${pad(` ${paint.fg(run.status === "failed" ? "error" : run.status === "completed" ? "success" : "warning", run.status.padEnd(9))} ${bot?.name ?? run.botId}`, inner)}│`;
      });
    return [
      top,
      header,
      stats,
      divider,
      `│${pad(` ${paint.fg("muted", "BOTS")}`, inner)}│`,
      ...rows,
      `│${pad("", inner)}│`,
      `│${pad(` ${paint.fg("muted", "RECENT RUNS")}`, inner)}│`,
      ...(recent.length > 0 ? recent : [`│${pad(" No runs yet.", inner)}│`]),
      divider,
      `│${pad(` ${paint.fg("accent", "[A]")} new  [R] run  [E] edit  [D] delete  [C] channel  [Esc] close`, inner)}│`,
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
  const window = botWindow(snapshot.workspace.bots, selectedBot, 9);
  const botRows = window.bots;
  const channelRows = snapshot.workspace.channels.slice(0, 9);
  const runRows = snapshot.workspace.runs.slice(-9).reverse();
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
    rows.push(
      line(
        bot
          ? ` ${botRow(bot, window.start + index === selectedBot, paint, leftWidth - 2)}`
          : "",
        channel ? ` # ${channel.name}` : "",
        run
          ? ` ${paint.fg(run.status === "failed" ? "error" : run.status === "completed" ? "success" : "warning", run.status)}  ${runBot?.name ?? run.botId}`
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
      ` ${paint.fg("muted", "BOTS")}`,
      ` ${paint.fg("muted", "CHANNELS")}`,
      ` ${paint.fg("muted", "RECENT RUNS")}`,
      widths,
    ),
    panelDivider,
    ...rows,
    panelDivider,
    line(
      ` ${paint.fg("accent", "[A]")} new  [R] run  [E] edit  [D] delete`,
      ` ${paint.fg("accent", "[C]")} new channel`,
      " [↑↓] select  [Esc] close",
      widths,
    ),
    bottom,
  ];
}

export class Dashboard implements Component {
  private selectedBot = 0;
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
    return renderDashboard(this.snapshot, width, this.selectedBot, this.theme);
  }

  handleInput(data: string): void {
    const count = this.snapshot.workspace.bots.length;
    const key = data.toLowerCase();
    if ((matchesKey(data, Key.up) || data === "k") && count > 0) {
      this.selectedBot = (this.selectedBot - 1 + count) % count;
      this.requestRender();
      return;
    }
    if ((matchesKey(data, Key.down) || data === "j") && count > 0) {
      this.selectedBot = (this.selectedBot + 1) % count;
      this.requestRender();
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
    const bot = this.snapshot.workspace.bots[this.selectedBot];
    if (!bot) return;
    if (key === "r") this.onAction({ type: "run-bot", botId: bot.id });
    else if (key === "e") this.onAction({ type: "edit-bot", botId: bot.id });
    else if (key === "d") this.onAction({ type: "delete-bot", botId: bot.id });
  }

  invalidate(): void {}
}
