import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TEAM_BINDING_NAMESPACE } from "./team.ts";

interface Binding {
  url: string;
  token: string;
}
function binding(): Binding | undefined {
  try {
    const root = JSON.parse(
      process.env.PI_SUBAGENT_EXTENSION_BINDINGS ?? "{}",
    ) as Record<string, unknown>;
    const value = root[TEAM_BINDING_NAMESPACE];
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.url !== "string" ||
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(candidate.url) ||
      typeof candidate.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.token)
    )
      return undefined;
    return { url: candidate.url, token: candidate.token };
  } catch {
    return undefined;
  }
}
async function request(
  action: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<{ text: string; details?: unknown }> {
  const control = binding();
  if (!control)
    throw new Error("Pi Bot team control is unavailable for this run.");
  const timeout = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(control.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${control.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action, params }),
    signal: combined,
  });
  const data = (await response.json()) as {
    ok?: boolean;
    text?: string;
    details?: unknown;
    error?: string;
  };
  if (!response.ok || !data.ok)
    throw new Error(data.error || "Pi Bot team control rejected the request.");
  return { text: data.text ?? "Done.", details: data.details };
}
function result(value: { text: string; details?: unknown }) {
  return {
    content: [{ type: "text" as const, text: value.text }],
    details: value.details ?? {},
  };
}
export default function teamRuntime(pi: ExtensionAPI) {
  pi.events.emit("subagent:acknowledge-extension", {
    id: "pi-bot.team-runtime",
  });
  pi.registerTool({
    name: "team_inspect",
    label: "Team Inspect",
    description:
      "Inspect descendants, groups, recent runs, and final replies within your managed subtree.",
    parameters: Type.Object({}),
    async execute(_id, params, signal) {
      return result(await request("inspect", params, signal));
    },
  });
  pi.registerTool({
    name: "team_catalog",
    label: "Team Catalog",
    description:
      "List exact available models and supported reasoning effort within your inherited provider cap. Results are paginated.",
    parameters: Type.Object({
      provider: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    }),
    async execute(_id, params, signal) {
      return result(await request("catalog", params, signal));
    },
  });
  pi.registerTool({
    name: "team_change",
    label: "Team Change",
    description:
      "Hire a descendant, create a managed group, or archive a descendant. Every action is validated against inherited caps and audited.",
    parameters: Type.Object({
      action: StringEnum(["hire", "create_group", "archive"] as const),
      name: Type.Optional(Type.String()),
      role: Type.Optional(Type.String()),
      purpose: Type.Optional(Type.String()),
      instructions: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(
        StringEnum([
          "off",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ] as const),
      ),
      tools: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
      groupId: Type.Optional(Type.String()),
      temporaryHours: Type.Optional(Type.Number({ minimum: 1, maximum: 720 })),
      canManageTeam: Type.Optional(Type.Boolean()),
      maxDirectReports: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 100 }),
      ),
      maxTeamSize: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
      maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
      botId: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal) {
      return result(await request("change", params, signal));
    },
  });
  pi.registerTool({
    name: "team_delegate",
    label: "Team Delegate",
    description:
      "Delegate a task to an active descendant. The task is persisted in that bot's direct conversation and returns a run receipt.",
    parameters: Type.Object({
      botId: Type.String(),
      task: Type.String({ minLength: 1, maxLength: 8192 }),
    }),
    async execute(_id, params, signal) {
      return result(await request("delegate", params, signal));
    },
  });
}
