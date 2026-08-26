import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateToolName } from "./tools.ts";
import {
  type BotProfile,
  type Channel,
  type RunRecord,
  THINKING_LEVELS,
  type Workspace,
} from "./types.ts";

const MAX_SHORT_TEXT = 160;
const MAX_LONG_TEXT = 8_192;
const MAX_BOTS = 100;
const MAX_CHANNELS = 100;
const MAX_RUNS = 100;
const MAX_STATE_BYTES = 1024 * 1024;
const saveQueues = new Map<string, Promise<void>>();

function nonEmptyString(
  value: unknown,
  field: string,
  maxLength = MAX_SHORT_TEXT,
): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    throw new Error(
      `${field} must be a trimmed string between 1 and ${maxLength} characters.`,
    );
  }
  return value;
}

function botId(value: unknown, field: string): string {
  const id = nonEmptyString(value, field, 64);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
    throw new Error(`${field} must be a lowercase ASCII slug.`);
  return id;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength = MAX_SHORT_TEXT,
): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, field, maxLength);
}

function stringList(value: unknown, field: string, maxItems = 64): string[] {
  if (!Array.isArray(value) || value.length > maxItems)
    throw new Error(
      `${field} must be an array with at most ${maxItems} items.`,
    );
  return [
    ...new Set(
      value.map((item, index) => nonEmptyString(item, `${field}[${index}]`)),
    ),
  ];
}

function isoDate(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  if (!Number.isFinite(Date.parse(text)))
    throw new Error(`${field} must be an ISO date.`);
  return text;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean")
    throw new Error(`${field} must be a boolean.`);
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!slug)
    throw new Error("The name must contain at least one letter or number.");
  return slug;
}

function parseChannel(value: unknown, index: number): Channel {
  const input = record(value, `channels[${index}]`);
  return {
    id: nonEmptyString(input.id, `channels[${index}].id`, 64),
    name: nonEmptyString(input.name, `channels[${index}].name`, 80),
    topic: nonEmptyString(input.topic, `channels[${index}].topic`, 500),
    createdAt: isoDate(input.createdAt, `channels[${index}].createdAt`),
  };
}

function parseBot(value: unknown, index: number): BotProfile {
  const input = record(value, `bots[${index}]`);
  const personality = record(input.personality, `bots[${index}].personality`);
  const modelPolicy = record(input.modelPolicy, `bots[${index}].modelPolicy`);
  const activation = record(input.activation, `bots[${index}].activation`);
  const thinking = nonEmptyString(
    modelPolicy.thinking,
    `bots[${index}].modelPolicy.thinking`,
  );
  if (!(THINKING_LEVELS as readonly string[]).includes(thinking))
    throw new Error(`bots[${index}].modelPolicy.thinking is not supported.`);
  const tools = stringList(input.tools, `bots[${index}].tools`).map(
    validateToolName,
  );
  return {
    id: botId(input.id, `bots[${index}].id`),
    name: nonEmptyString(input.name, `bots[${index}].name`, 80),
    role: nonEmptyString(input.role, `bots[${index}].role`, 120),
    description: nonEmptyString(
      input.description,
      `bots[${index}].description`,
      500,
    ),
    personality: {
      summary: nonEmptyString(
        personality.summary,
        `bots[${index}].personality.summary`,
        MAX_LONG_TEXT,
      ),
      principles: nonEmptyString(
        personality.principles,
        `bots[${index}].personality.principles`,
        MAX_LONG_TEXT,
      ),
      boundaries: nonEmptyString(
        personality.boundaries,
        `bots[${index}].personality.boundaries`,
        MAX_LONG_TEXT,
      ),
    },
    instructions: nonEmptyString(
      input.instructions,
      `bots[${index}].instructions`,
      MAX_LONG_TEXT,
    ),
    tools,
    modelPolicy: {
      ...(optionalString(
        modelPolicy.preferred,
        `bots[${index}].modelPolicy.preferred`,
        200,
      )
        ? { preferred: modelPolicy.preferred as string }
        : {}),
      fallback: stringList(
        modelPolicy.fallback,
        `bots[${index}].modelPolicy.fallback`,
        8,
      ),
      thinking: thinking as BotProfile["modelPolicy"]["thinking"],
    },
    channelIds: stringList(
      input.channelIds,
      `bots[${index}].channelIds`,
      MAX_CHANNELS,
    ),
    activation: {
      manual: booleanValue(
        activation.manual,
        `bots[${index}].activation.manual`,
      ),
      mentions: booleanValue(
        activation.mentions,
        `bots[${index}].activation.mentions`,
      ),
    },
    inheritProjectContext: booleanValue(
      input.inheritProjectContext,
      `bots[${index}].inheritProjectContext`,
    ),
    version:
      Number.isInteger(input.version) && (input.version as number) > 0
        ? (input.version as number)
        : 1,
    createdAt: isoDate(input.createdAt, `bots[${index}].createdAt`),
    updatedAt: isoDate(input.updatedAt, `bots[${index}].updatedAt`),
  };
}

function parseRun(value: unknown, index: number): RunRecord {
  const input = record(value, `runs[${index}]`);
  const status = nonEmptyString(input.status, `runs[${index}].status`);
  if (
    ![
      "launched",
      "completed",
      "failed",
      "paused",
      "stopped",
      "unknown",
    ].includes(status)
  )
    throw new Error(`runs[${index}].status is invalid.`);
  return {
    id: nonEmptyString(input.id, `runs[${index}].id`, 128),
    botId: nonEmptyString(input.botId, `runs[${index}].botId`, 64),
    task: nonEmptyString(input.task, `runs[${index}].task`, MAX_LONG_TEXT),
    status: status as RunRecord["status"],
    createdAt: isoDate(input.createdAt, `runs[${index}].createdAt`),
    updatedAt: isoDate(input.updatedAt, `runs[${index}].updatedAt`),
  };
}

export function parseWorkspace(value: unknown): Workspace {
  const input = record(value, "workspace");
  if (input.schemaVersion !== 1)
    throw new Error("Unsupported Pi Bot workspace schema version.");
  if (!Array.isArray(input.bots) || input.bots.length > MAX_BOTS)
    throw new Error(`bots must contain at most ${MAX_BOTS} items.`);
  if (!Array.isArray(input.channels) || input.channels.length > MAX_CHANNELS)
    throw new Error(`channels must contain at most ${MAX_CHANNELS} items.`);
  if (!Array.isArray(input.runs) || input.runs.length > MAX_RUNS)
    throw new Error(`runs must contain at most ${MAX_RUNS} items.`);
  const workspace: Workspace = {
    schemaVersion: 1,
    name: nonEmptyString(input.name, "name", 80),
    projectPath: nonEmptyString(input.projectPath, "projectPath", 4_096),
    onboardingComplete: booleanValue(
      input.onboardingComplete,
      "onboardingComplete",
    ),
    bots: input.bots.map(parseBot),
    channels: input.channels.map(parseChannel),
    runs: input.runs.map(parseRun),
    createdAt: isoDate(input.createdAt, "createdAt"),
    updatedAt: isoDate(input.updatedAt, "updatedAt"),
  };
  if (
    new Set(workspace.bots.map((bot) => bot.id)).size !== workspace.bots.length
  )
    throw new Error("Bot IDs must be unique.");
  if (
    new Set(workspace.channels.map((channel) => channel.id)).size !==
    workspace.channels.length
  )
    throw new Error("Channel IDs must be unique.");
  const channelIds = new Set(workspace.channels.map((channel) => channel.id));
  if (
    workspace.bots.some((bot) =>
      bot.channelIds.some((id) => !channelIds.has(id)),
    )
  )
    throw new Error("Every bot channel must exist in the workspace.");
  return workspace;
}

export function storeRoot(): string {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "pi-bot", "projects");
}

export function workspacePath(cwd: string, root = storeRoot()): string {
  const project = resolve(cwd);
  const digest = createHash("sha256")
    .update(project)
    .digest("hex")
    .slice(0, 24);
  return join(root, digest, "workspace.json");
}

export async function loadWorkspace(
  cwd: string,
  root = storeRoot(),
): Promise<Workspace | undefined> {
  const path = workspacePath(cwd, root);
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile())
      throw new Error(
        "Pi Bot state must be a regular file, not a link or special file.",
      );
    if (metadata.size > MAX_STATE_BYTES)
      throw new Error(`Pi Bot state exceeds ${MAX_STATE_BYTES} bytes.`);
    return parseWorkspace(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function performSave(
  cwd: string,
  workspace: Workspace,
  root: string,
): Promise<void> {
  const path = workspacePath(cwd, root);
  const validated = parseWorkspace({
    ...workspace,
    projectPath: resolve(cwd),
    updatedAt: new Date().toISOString(),
    runs: workspace.runs.slice(-MAX_RUNS),
  });
  const directory = dirname(path);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory())
    throw new Error("Pi Bot state root must be a real directory.");
  await chmod(root, 0o700);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory())
    throw new Error("Pi Bot state directory must be a real directory.");
  await chmod(directory, 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES)
    throw new Error(`Pi Bot state exceeds ${MAX_STATE_BYTES} bytes.`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function saveWorkspace(
  cwd: string,
  workspace: Workspace,
  root = storeRoot(),
): Promise<void> {
  const path = workspacePath(cwd, root);
  const previous = saveQueues.get(path) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => performSave(cwd, workspace, root));
  saveQueues.set(path, current);
  try {
    await current;
  } finally {
    if (saveQueues.get(path) === current) saveQueues.delete(path);
  }
}

export function createWorkspace(
  name: string,
  cwd: string,
  now = new Date(),
): Workspace {
  const createdAt = now.toISOString();
  return {
    schemaVersion: 1,
    name: nonEmptyString(name.trim(), "name", 80),
    projectPath: resolve(cwd),
    onboardingComplete: true,
    bots: [],
    channels: [
      {
        id: "general",
        name: "general",
        topic: "Shared team updates and decisions.",
        createdAt,
      },
    ],
    runs: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export function createBotId(name: string, bots: readonly BotProfile[]): string {
  const base = slugify(name);
  if (!bots.some((bot) => bot.id === base)) return base;
  for (let suffix = 2; suffix <= MAX_BOTS; suffix += 1) {
    const suffixText = `-${suffix}`;
    const candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    if (!bots.some((bot) => bot.id === candidate)) return candidate;
  }
  throw new Error("No unique bot ID is available.");
}
