import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  botModelKey,
  selectableBotModels,
  supportedBotThinkingLevels,
} from "./models.ts";
import { createBotId, slugify } from "./store.ts";
import { validateToolName } from "./tools.ts";
import {
  type BotProfile,
  type TeamAuditReceipt,
  type TeamGroup,
  type TeamManagementPolicy,
  THINKING_LEVELS,
  type ThinkingLevel,
  type Workspace,
} from "./types.ts";

export const MAX_TEAM_AUDIT = 500;
export const TEAM_BINDING_NAMESPACE = "pi-bot.team/1";
export const TEAM_TOOL_NAMES = [
  "team_inspect",
  "team_catalog",
  "team_change",
  "team_delegate",
] as const;

export type TeamChangeRequest =
  | {
      action: "hire";
      name: string;
      role: string;
      purpose: string;
      instructions: string;
      model: string;
      thinking: ThinkingLevel;
      tools?: string[];
      groupId?: string;
      temporaryHours?: number;
      canManageTeam?: boolean;
      maxDirectReports?: number;
      maxTeamSize?: number;
      maxDepth?: number;
    }
  | { action: "create_group"; name: string; purpose: string }
  | { action: "archive"; botId: string; reason: string };

function active(bot: BotProfile | undefined): boolean {
  return bot !== undefined && (bot.status ?? "active") === "active";
}
function children(workspace: Workspace, id: string): BotProfile[] {
  return workspace.bots.filter((bot) => bot.parentId === id);
}
export function descendantIds(
  workspace: Workspace,
  actorId: string,
): Set<string> {
  const result = new Set<string>();
  const queue = [actorId];
  while (queue.length) {
    const parent = queue.shift();
    if (!parent) break;
    for (const child of children(workspace, parent))
      if (!result.has(child.id)) {
        result.add(child.id);
        queue.push(child.id);
      }
  }
  return result;
}
function policyFor(
  workspace: Workspace,
  actorId: string,
): { actor: BotProfile; policy: TeamManagementPolicy } {
  const actor = workspace.bots.find((bot) => bot.id === actorId);
  if (!actor || !active(actor)) throw new Error("Team actor is unavailable.");
  if (!actor.management?.enabled)
    throw new Error(`${actor.name} cannot manage a team.`);
  return { actor, policy: actor.management };
}
function boundedInt(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 0 || result > max)
    throw new Error(`Team limit must be between 0 and ${max}.`);
  return result;
}
function appendAudit(workspace: Workspace, receipt: TeamAuditReceipt): void {
  workspace.teamAudit.push(receipt);
  workspace.teamAudit = workspace.teamAudit.slice(-MAX_TEAM_AUDIT);
}
function receipt(
  actorId: string,
  action: TeamAuditReceipt["action"],
  targetId: string,
  summary: string,
  now: string,
): TeamAuditReceipt {
  return {
    id: randomUUID(),
    actorId,
    action,
    targetId,
    summary: summary.slice(0, 500),
    createdAt: now,
  };
}
export function archiveExpiredBots(
  workspace: Workspace,
  now = new Date(),
): string[] {
  const expiredRoots = workspace.bots.filter(
    (bot) =>
      active(bot) &&
      bot.lifetime?.kind === "temporary" &&
      Boolean(bot.lifetime.expiresAt) &&
      Date.parse(bot.lifetime.expiresAt ?? "") <= now.getTime(),
  );
  const ids = new Set<string>();
  for (const root of expiredRoots) {
    ids.add(root.id);
    for (const id of descendantIds(workspace, root.id)) ids.add(id);
  }
  const timestamp = now.toISOString();
  for (const id of ids) {
    const bot = workspace.bots.find((item) => item.id === id);
    if (!bot || !active(bot)) continue;
    bot.status = "archived";
    bot.updatedAt = timestamp;
    appendAudit(
      workspace,
      receipt(
        bot.parentId ?? bot.id,
        "expire",
        bot.id,
        bot.id === rootIdFor(workspace, bot.id, expiredRoots)
          ? "Temporary bot expired."
          : "Archived with an expired manager.",
        timestamp,
      ),
    );
  }
  return [...ids];
}

function rootIdFor(
  workspace: Workspace,
  botId: string,
  roots: readonly BotProfile[],
): string | undefined {
  let current = workspace.bots.find((bot) => bot.id === botId);
  while (current) {
    if (roots.some((root) => root.id === current?.id)) return current.id;
    current = current.parentId
      ? workspace.bots.find((bot) => bot.id === current?.parentId)
      : undefined;
  }
  return undefined;
}
export function restoreBot(
  workspace: Workspace,
  botId: string,
  now = new Date().toISOString(),
): void {
  const bot = workspace.bots.find((item) => item.id === botId);
  if (!bot) throw new Error(`Unknown bot: ${botId}`);
  if ((bot.status ?? "active") === "active") return;
  if (
    bot.parentId &&
    !active(workspace.bots.find((item) => item.id === bot.parentId))
  )
    throw new Error("Restore the parent manager first.");
  bot.status = "active";
  bot.lifetime = { kind: "permanent" };
  bot.updatedAt = now;
  appendAudit(
    workspace,
    receipt("user", "restore", bot.id, `${bot.name} restored.`, now),
  );
}
export function applyTeamChange(
  workspace: Workspace,
  context: Pick<ExtensionContext, "modelRegistry" | "scopedModels">,
  actorId: string,
  request: TeamChangeRequest,
  now = new Date(),
): { targetId: string; summary: string } {
  const { actor, policy } = policyFor(workspace, actorId);
  const descendants = descendantIds(workspace, actorId);
  const timestamp = now.toISOString();
  if (request.action === "create_group") {
    const id = slugify(request.name);
    if (workspace.groups.some((group) => group.id === id))
      throw new Error(`Group ${id} already exists.`);
    const group: TeamGroup = {
      id,
      name: request.name.trim().slice(0, 80),
      purpose: request.purpose.trim().slice(0, 500),
      managerId: actorId,
      status: "active",
      createdAt: timestamp,
    };
    if (!group.name || !group.purpose)
      throw new Error("Group name and purpose are required.");
    workspace.groups.push(group);
    appendAudit(
      workspace,
      receipt(
        actorId,
        "create_group",
        id,
        `Created group ${group.name}.`,
        timestamp,
      ),
    );
    return { targetId: id, summary: `Created group ${group.name}.` };
  }
  if (request.action === "archive") {
    if (!descendants.has(request.botId))
      throw new Error("Managers can archive only their descendants.");
    const target = workspace.bots.find((bot) => bot.id === request.botId);
    if (!target || !active(target))
      throw new Error("Target bot is not active.");
    if (children(workspace, target.id).some(active))
      throw new Error("Archive or reassign active direct reports first.");
    target.status = "archived";
    target.updatedAt = timestamp;
    appendAudit(
      workspace,
      receipt(actorId, "archive", target.id, request.reason, timestamp),
    );
    return { targetId: target.id, summary: `Archived ${target.name}.` };
  }
  for (
    let manager: BotProfile | undefined = actor;
    manager;
    manager = manager.parentId
      ? workspace.bots.find((bot) => bot.id === manager?.parentId)
      : undefined
  ) {
    const cap = manager.management?.maxTeamSize;
    if (
      cap !== undefined &&
      [...descendantIds(workspace, manager.id)].filter((id) =>
        active(workspace.bots.find((bot) => bot.id === id)),
      ).length >= cap
    )
      throw new Error(`${manager.name} subtree-size cap reached.`);
  }
  const direct = children(workspace, actorId).filter(active).length;
  if (direct >= policy.maxDirectReports)
    throw new Error("Direct-report cap reached.");
  if (
    [...descendants].filter((id) =>
      active(workspace.bots.find((bot) => bot.id === id)),
    ).length >= policy.maxTeamSize
  )
    throw new Error("Team-size cap reached.");
  if (policy.maxDepth < 1) throw new Error("Team-depth cap reached.");
  const model = selectableBotModels(context).find(
    (candidate) => botModelKey(candidate) === request.model,
  );
  if (!model || !policy.allowedProviders.includes(model.provider))
    throw new Error(
      "Requested model is outside the manager cap or unavailable.",
    );
  if (!supportedBotThinkingLevels(model).includes(request.thinking))
    throw new Error(
      "Requested reasoning effort is not supported by the model.",
    );
  if (
    THINKING_LEVELS.indexOf(request.thinking) >
    THINKING_LEVELS.indexOf(policy.maxThinking)
  )
    throw new Error("Requested reasoning effort exceeds the manager cap.");
  const tools = [...new Set(request.tools ?? [])].map(validateToolName);
  if (tools.some((tool) => !policy.allowedTools.includes(tool)))
    throw new Error("Requested tools exceed the manager cap.");
  if (request.groupId) {
    const group = workspace.groups.find(
      (item) => item.id === request.groupId && item.status === "active",
    );
    if (
      !group ||
      (group.managerId !== actorId && !descendants.has(group.managerId))
    )
      throw new Error("Requested group is outside the manager subtree.");
  }
  const id = createBotId(request.name, workspace.bots);
  const canManage = Boolean(request.canManageTeam);
  const childPolicy = canManage
    ? ({
        enabled: true,
        allowedProviders: [...policy.allowedProviders],
        allowedTools: [...policy.allowedTools],
        maxThinking: request.thinking,
        maxDirectReports: boundedInt(
          request.maxDirectReports,
          Math.min(3, policy.maxDirectReports),
          policy.maxDirectReports,
        ),
        maxTeamSize: boundedInt(
          request.maxTeamSize,
          Math.min(10, Math.max(0, policy.maxTeamSize - 1)),
          Math.max(0, policy.maxTeamSize - 1),
        ),
        maxDepth: boundedInt(
          request.maxDepth,
          Math.max(0, policy.maxDepth - 1),
          Math.max(0, policy.maxDepth - 1),
        ),
      } satisfies TeamManagementPolicy)
    : undefined;
  const temporaryHours = request.temporaryHours;
  if (
    temporaryHours !== undefined &&
    (!Number.isFinite(temporaryHours) ||
      temporaryHours <= 0 ||
      temporaryHours > 24 * 30)
  )
    throw new Error("Temporary lifetime must be between 0 and 720 hours.");
  const bot: BotProfile = {
    id,
    name: request.name.trim().slice(0, 80),
    role: request.role.trim().slice(0, 120),
    description: request.purpose.trim().slice(0, 500),
    personality: {
      summary: "Professional, direct, and collaborative.",
      principles:
        "Use evidence. Escalate decisions that exceed assigned authority.",
      boundaries:
        "Stay within the assigned role, tools, model policy, and management caps.",
    },
    instructions: request.instructions.trim().slice(0, 8_192),
    tools,
    modelPolicy: {
      preferred: request.model,
      fallback: [],
      thinking: request.thinking,
    },
    channelIds: [],
    activation: { manual: true, mentions: true },
    inheritProjectContext: actor.inheritProjectContext,
    parentId: actorId,
    ...(request.groupId ? { groupId: request.groupId } : {}),
    status: "active",
    lifetime: temporaryHours
      ? {
          kind: "temporary",
          expiresAt: new Date(
            now.getTime() + temporaryHours * 3_600_000,
          ).toISOString(),
        }
      : { kind: "permanent" },
    ...(childPolicy ? { management: childPolicy } : {}),
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (!bot.name || !bot.role || !bot.description || !bot.instructions)
    throw new Error("Hire fields must be non-empty.");
  workspace.bots.push(bot);
  appendAudit(
    workspace,
    receipt(
      actorId,
      "hire",
      id,
      `Hired ${bot.name} as ${bot.role}.`,
      timestamp,
    ),
  );
  return { targetId: id, summary: `Hired ${bot.name} as ${bot.role}.` };
}

export function inspectTeam(workspace: Workspace, actorId: string): object {
  policyFor(workspace, actorId);
  const ids = descendantIds(workspace, actorId);
  return {
    actorId,
    groups: workspace.groups.filter(
      (group) => group.managerId === actorId || ids.has(group.managerId),
    ),
    bots: workspace.bots
      .filter((bot) => ids.has(bot.id))
      .map((bot) => ({
        id: bot.id,
        name: bot.name,
        role: bot.role,
        parentId: bot.parentId,
        groupId: bot.groupId,
        status: bot.status ?? "active",
        management: Boolean(bot.management?.enabled),
        latestRun: workspace.runs.filter((run) => run.botId === bot.id).at(-1),
        latestReply: workspace.conversations
          .find((thread) => thread.id === `bot:${bot.id}`)
          ?.messages.filter(
            (message) =>
              message.author === "bot" && message.status !== "pending",
          )
          .at(-1)
          ?.content.slice(0, 4_096),
      })),
  };
}
