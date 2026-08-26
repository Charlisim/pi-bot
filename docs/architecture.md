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

The store owns user-created profiles, channels, and bounded run receipts. It does not own subagent transcripts or artifacts.

Properties:

- One state file per canonical project path.
- Schema version 1.
- Maximum 1 MiB.
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
- Optional preferred model.
- Explicit thinking level.
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

Requests subscribe to the correlated reply before they emit. Timeouts and shutdown remove listeners. Launches are detached and asynchronous.

Detailed run state, artifacts, cancellation, steering, and recovery remain owned by pi-subagents.

## Authority

Personality fields only compile into the system prompt. They never populate runtime authority fields.

Tool authority comes from an explicit human selection. Pi Bot denies recursive orchestration tools and unknown extension tools in version 0.1. Any built-in tool outside the advisory set is treated as elevated.

## Known limits

- Tool restrictions are not an OS sandbox.
- Detached runs can outlive the owning Pi session. Completion UI may not survive that shutdown; unreconciled receipts are marked `unknown` on the next session instead of claiming success or failure.
- A configured model name is resolved by pi-subagents at launch.
- Local channels are organizational labels in version 0.1. They are not external chat transports.
