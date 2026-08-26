export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface Personality {
  summary: string;
  principles: string;
  boundaries: string;
}

export interface ModelPolicy {
  preferred?: string;
  fallback: string[];
  thinking: ThinkingLevel;
}

export interface ActivationSettings {
  manual: boolean;
  mentions: boolean;
}

export interface BotProfile {
  id: string;
  name: string;
  role: string;
  description: string;
  personality: Personality;
  instructions: string;
  tools: string[];
  modelPolicy: ModelPolicy;
  channelIds: string[];
  activation: ActivationSettings;
  inheritProjectContext: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Channel {
  id: string;
  name: string;
  topic: string;
  createdAt: string;
}

export type RunStatus =
  | "launched"
  | "completed"
  | "failed"
  | "paused"
  | "stopped"
  | "unknown";

export interface RunRecord {
  id: string;
  botId: string;
  task: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  schemaVersion: 1;
  name: string;
  projectPath: string;
  onboardingComplete: boolean;
  bots: BotProfile[];
  channels: Channel[];
  runs: RunRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSnapshot {
  workspace: Workspace;
  engineReady: boolean;
}
