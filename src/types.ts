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

export interface TeamManagementPolicy {
  enabled: boolean;
  allowedProviders: string[];
  allowedTools: string[];
  maxThinking: ThinkingLevel;
  maxDirectReports: number;
  maxTeamSize: number;
  maxDepth: number;
}

export interface BotLifetime {
  kind: "permanent" | "temporary";
  expiresAt?: string;
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
  parentId?: string;
  groupId?: string;
  status?: "active" | "archived";
  lifetime?: BotLifetime;
  management?: TeamManagementPolicy;
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

export type ConversationKind = "bot" | "channel";
export type ConversationMessageStatus = "pending" | "completed" | "failed";

export interface ConversationMessage {
  id: string;
  author: "user" | "bot";
  botId?: string;
  content: string;
  status: ConversationMessageStatus;
  runId?: string;
  responseId?: string;
  createdAt: string;
}

export interface ConversationContext {
  botId: string;
  runId: string;
  profileDigest?: string;
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  targetId: string;
  messages: ConversationMessage[];
  contexts: ConversationContext[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamGroup {
  id: string;
  name: string;
  purpose: string;
  managerId: string;
  status: "active" | "archived";
  createdAt: string;
}

export interface TeamAuditReceipt {
  id: string;
  actorId: string;
  action:
    | "hire"
    | "create_group"
    | "archive"
    | "restore"
    | "expire"
    | "delegate";
  targetId: string;
  summary: string;
  createdAt: string;
}

export interface Workspace {
  schemaVersion: 1;
  name: string;
  projectPath: string;
  onboardingComplete: boolean;
  bots: BotProfile[];
  channels: Channel[];
  runs: RunRecord[];
  conversations: Conversation[];
  groups: TeamGroup[];
  teamAudit: TeamAuditReceipt[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSnapshot {
  workspace: Workspace;
  engineReady: boolean;
}
