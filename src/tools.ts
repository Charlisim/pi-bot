export const BUILTIN_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
] as const;
export const ADVISORY_TOOL_NAMES = new Set<string>([
  "read",
  "grep",
  "find",
  "ls",
]);
export const DENIED_TOOL_NAMES = new Set([
  "subagent",
  "subagent_wait",
  "contact_supervisor",
]);

export type AuthorityClass = "none" | "advisory" | "elevated";

export function validateToolName(tool: string): string {
  if (!/^[a-z][a-z0-9_.:-]{0,127}$/.test(tool))
    throw new Error(`Invalid tool name: ${JSON.stringify(tool)}`);
  if (DENIED_TOOL_NAMES.has(tool))
    throw new Error(
      `Pi Bot does not grant recursive orchestration tool '${tool}'.`,
    );
  if (!(BUILTIN_TOOL_NAMES as readonly string[]).includes(tool))
    throw new Error(`Unsupported tool in Pi Bot 0.1: ${tool}`);
  return tool;
}

export function classifyAuthority(tools: readonly string[]): AuthorityClass {
  if (tools.length === 0) return "none";
  return tools.every((tool) => ADVISORY_TOOL_NAMES.has(tool))
    ? "advisory"
    : "elevated";
}
