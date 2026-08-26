# Contributing to Pi Bot

Thank you for helping improve Pi Bot.

## Prerequisites

- Node.js 24.
- pnpm 11.5.2.
- Pi 0.84.3 or newer for manual testing.

## Set up

```bash
git clone https://github.com/Charlisim/pi-bot.git
cd pi-bot
pnpm install
pnpm check
```

Use pnpm for this repository. Commit `pnpm-lock.yaml` changes when dependencies change.

## Before opening a pull request

Run:

```bash
pnpm check
pnpm evidence
pnpm pack --dry-run
```

Confirm that:

- The package still ships no default agents.
- Importing the extension creates no local state.
- New authority is explicit and fail-closed.
- UI lines stay within the requested terminal width.
- Documentation and screenshots match the behavior.

## Design rules

- Keep personality separate from tool authority.
- Do not infer permissions from generated text.
- Do not add install scripts, telemetry, or hidden network calls.
- Use documented Pi and pi-subagents public APIs.
- Keep onboarding usable without provider credentials.
- Keep all product text and code comments in English.

## Pull requests

Use a focused title and explain:

1. The user problem.
2. The smallest solution.
3. Security or authority changes.
4. Tests and manual evidence.

By contributing, you agree that your contribution is licensed under the MIT License.
