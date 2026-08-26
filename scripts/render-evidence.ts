import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderDashboard } from "../src/dashboard.ts";
import { createWorkspace } from "../src/store.ts";
import type { BotProfile, WorkspaceSnapshot } from "../src/types.ts";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderSvg(lines: string[], title: string): string {
  const lineHeight = 22;
  const width = 1240;
  const height = 72 + lines.length * lineHeight;
  const text = lines
    .map(
      (line, index) =>
        `<text x="34" y="${58 + index * lineHeight}">${escapeXml(line)}</text>`,
    )
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <title>${escapeXml(title)}</title>
  <rect width="100%" height="100%" rx="18" fill="#0b1114"/>
  <rect x="12" y="12" width="1216" height="${height - 24}" rx="12" fill="#10191d" stroke="#31515a"/>
  <style>
    text { fill: #d8e6e1; font: 16px 'Iosevka', 'JetBrains Mono', monospace; white-space: pre; }
  </style>
  ${text}
</svg>\n`;
}

function bot(
  id: string,
  name: string,
  role: string,
  tools: string[],
): BotProfile {
  const now = "2026-08-26T00:00:00.000Z";
  return {
    id,
    name,
    role,
    description: role,
    personality: {
      summary: "Clear and direct.",
      principles: "Use evidence.",
      boundaries: "Ask before expanding scope.",
    },
    instructions: "Complete the assigned task and report evidence.",
    tools,
    modelPolicy: { fallback: [], thinking: "high" },
    channelIds: ["general"],
    activation: { manual: true, mentions: true },
    inheritProjectContext: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

const emptyWorkspace = createWorkspace(
  "Acme Studio",
  "/projects/acme",
  new Date("2026-08-26T00:00:00.000Z"),
);
const populatedWorkspace = structuredClone(emptyWorkspace);
populatedWorkspace.bots = [
  bot("atlas", "Atlas", "Product strategist", []),
  bot("lumen", "Lumen", "UX researcher", ["read", "grep", "find", "ls"]),
  bot("forge", "Forge", "Implementation engineer", [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "edit",
    "write",
  ]),
];
populatedWorkspace.channels.push({
  id: "product",
  name: "product",
  topic: "Product decisions",
  createdAt: "2026-08-26T00:00:00.000Z",
});
populatedWorkspace.runs = [
  {
    id: "run-1",
    botId: "atlas",
    task: "Scope onboarding",
    status: "completed",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:02:00.000Z",
  },
  {
    id: "run-2",
    botId: "lumen",
    task: "Review the empty state",
    status: "launched",
    createdAt: "2026-08-26T00:03:00.000Z",
    updatedAt: "2026-08-26T00:03:00.000Z",
  },
];

const targets: Array<{
  path: string;
  title: string;
  snapshot: WorkspaceSnapshot;
}> = [
  {
    path: "docs/images/pi-bot-empty.svg",
    title: "Pi Bot empty workspace",
    snapshot: { workspace: emptyWorkspace, engineReady: true },
  },
  {
    path: "docs/images/pi-bot-dashboard.svg",
    title: "Pi Bot team dashboard",
    snapshot: { workspace: populatedWorkspace, engineReady: true },
  },
];

for (const target of targets) {
  const path = resolve(target.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    renderSvg(renderDashboard(target.snapshot, 118), target.title),
  );
  process.stdout.write(`Rendered ${target.path}\n`);
}
