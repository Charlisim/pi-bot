import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { serializeRuntimeAgent } from "./agent.ts";
import type { Workspace } from "./types.ts";

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function projectDigest(projectPath: string): string {
  return createHash("sha256")
    .update(resolve(projectPath))
    .digest("hex")
    .slice(0, 24);
}

function agentRoot(): string {
  return join(agentDir(), "agents", "pi-bot");
}

function stagingRoot(): string {
  return join(agentDir(), ".pi-bot-staging");
}

export function projectAgentDirectory(projectPath: string): string {
  return join(agentRoot(), projectDigest(projectPath));
}

export function runtimeAgentFile(projectPath: string, botId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(botId))
    throw new Error(`Invalid bot ID: ${botId}`);
  return join(projectAgentDirectory(projectPath), `${botId}.md`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureOwnedDirectory(path: string): Promise<void> {
  const parent = resolve(agentDir());
  const target = resolve(path);
  if (target !== parent && !target.startsWith(`${parent}/`))
    throw new Error(
      "Pi Bot directory escaped the configured Pi agent directory.",
    );
  const relative = target.slice(parent.length).split("/").filter(Boolean);
  let current = parent;
  await mkdir(current, { recursive: true, mode: 0o700 });
  for (const segment of relative) {
    current = join(current, segment);
    if (!(await pathExists(current))) await mkdir(current, { mode: 0o700 });
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      throw new Error(`Pi Bot refuses linked or special directory: ${current}`);
    await chmod(current, 0o700);
  }
}

async function writeProfile(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface AgentPublishTransaction {
  quarantine(): Promise<void>;
  activate(): Promise<void>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

export async function stageWorkspaceAgents(
  workspace: Workspace,
): Promise<AgentPublishTransaction> {
  const transactionId = randomUUID();
  const stagingBase = stagingRoot();
  const stage = join(stagingBase, `${transactionId}.next`);
  const backup = join(stagingBase, `${transactionId}.previous`);
  const target = projectAgentDirectory(workspace.projectPath);
  await ensureOwnedDirectory(stagingBase);
  await ensureOwnedDirectory(agentRoot());
  await ensureOwnedDirectory(stage);

  try {
    for (const bot of workspace.bots) {
      await writeProfile(
        join(stage, `${bot.id}.md`),
        serializeRuntimeAgent(bot, workspace.projectPath),
      );
    }
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }

  let quarantined = false;
  let activated = false;
  let settled = false;
  return {
    async quarantine() {
      if (settled || quarantined) return;
      if (await pathExists(target)) {
        const metadata = await lstat(target);
        if (metadata.isSymbolicLink() || !metadata.isDirectory())
          throw new Error("Pi Bot agent target must be a real directory.");
        await rename(target, backup);
      }
      quarantined = true;
    },
    async activate() {
      if (settled || activated) return;
      if (!quarantined)
        throw new Error(
          "Pi Bot profiles must be quarantined before activation.",
        );
      await rename(stage, target);
      activated = true;
    },
    async rollback() {
      if (settled) return;
      settled = true;
      if (activated) await rm(target, { recursive: true, force: true });
      else await rm(stage, { recursive: true, force: true });
      if (quarantined && (await pathExists(backup)))
        await rename(backup, target);
    },
    async finalize() {
      if (settled) return;
      settled = true;
      await rm(stage, { recursive: true, force: true });
      await rm(backup, { recursive: true, force: true });
      if (workspace.bots.length === 0)
        await rm(target, { recursive: true, force: true });
      const remaining = await readdir(stagingBase).catch(() => []);
      if (remaining.length === 0)
        await rm(stagingBase, { recursive: true, force: true });
    },
  };
}

export async function publishWorkspaceAgents(
  workspace: Workspace,
): Promise<void> {
  const transaction = await stageWorkspaceAgents(workspace);
  await transaction.quarantine();
  try {
    await transaction.activate();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
  await transaction.finalize();
}
