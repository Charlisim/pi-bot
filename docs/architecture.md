# Architecture

Pi Bot is one Pi extension with three boundaries.

```text
┌────────────────────────────────────────────────────┐
│ Pi Bot extension                                   │
│                                                    │
│ Onboarding + dashboard                             │
│        │                                           │
│        ├── local workspace store                   │
│        ├── user agent profile publisher            │
│        └── pi-subagents RPC client                 │
└───────────────────────────┬────────────────────────┘
                            │
                            ▼
                  pi-subagents async runs
```

## Workspace store

The store owns user-created profiles, channels, bounded run receipts, and local conversation history. Conversation history contains human messages and final bot responses. It does not contain raw subagent transcripts, tool output, or artifacts.

Properties:

- One state file per canonical project path.
- Schema version 1.
- Maximum 16 MiB and 10,000 conversation messages per project.
- Regular files only.
- Mode `0600` on supported systems.
- Atomic temporary write, file sync, rename, and directory sync.
- Serialized writes per workspace.

A missing file means no workspace and no agents. Importing the package does not create state.

## User agent profiles

Each saved bot is published in pi-subagents' documented Markdown agent format under:

```text
~/.pi/agent/agents/pi-bot/<project-hash>/<bot-id>.md
```

The runtime name contains the project hash and bot ID. This prevents two projects with an `atlas` bot from colliding.

Pi Bot writes these fields explicitly:

- Compiled system prompt.
- Tool list, including an explicit empty list.
- Exact model selected from Pi's active registry.
- Explicit thinking level supported by that model.
- Fresh child context.
- No inherited skills or ambient child extensions.
- Maximum subagent depth of one.
- Read-only or writer acceptance role from effective tools.

Files use fixed package-owned paths and restrictive permissions. A complete profile set is staged outside discovery. The old set is then quarantined, state is saved, and the candidate set is activated. Save failures restore the old profiles. Activation failures compensate state and profiles when possible, or leave profiles disabled. Deleting the last bot removes its generated runtime profiles.

## Execution RPC

Pi Bot uses the documented version 1 in-process event protocol:

```text
subagents:rpc:v1:request
subagents:rpc:v1:reply:<request-id>
subagents:rpc:v1:ready
subagent:async-complete
```

Requests subscribe to the correlated reply before they emit. Timeouts and shutdown remove listeners. Launches are detached and asynchronous. Direct conversations and each bot lane in a channel keep the latest run ID and a digest of the effective bot profile. Pi Bot resumes ordinary bots only when that digest still matches. Managers always start a fresh child with saved conversation history so each run receives a new control token and binding.

Each conversation launch writes its final response to a private package-owned response file. Pi Bot folds that response into the atomic workspace state and removes the file. This lets startup reconciliation recover a completed response that arrived while the TUI was unavailable.

Detailed run state, artifacts, cancellation, steering, and recovery remain owned by pi-subagents.

## Authority

Personality fields only compile into the system prompt. They never populate runtime authority fields.

Tool authority comes from an explicit human selection. Pi Bot denies recursive orchestration tools and unknown extension tools in version 0.1. Any built-in tool outside the advisory set is treated as elevated.

## Known limits

- Tool restrictions are not an OS sandbox.
- Detached runs can outlive the owning Pi session. Startup reconciliation recovers a saved final response when the child wrote one. It keeps the receipt pending when neither a terminal status nor a response file proves completion.
- New profiles select a provider and then an exact model from Pi's active or session-scoped registry. Model pages contain at most ten entries. Legacy unavailable IDs fail before a task or conversation message starts.
- Local channels are persistent project conversations. They are not external chat transports.

## Team control plane

Managed bots form a parent-linked tree. Each manager has inherited caps for providers, tools, reasoning effort, direct reports, subtree size, and depth. Descendant caps can only narrow. Manager profiles load a child-only runtime extension with `team_inspect`, `team_catalog`, `team_change`, and `team_delegate`; they never receive the recursive subagent tool. These tools use per-launch extension bindings to reach a private parent-owned localhost bridge. The parent maps bearer tokens to actors, validates every request, and applies state plus runtime-profile changes through the existing transaction queue. Archived bots keep history and do not publish runtime profiles.
