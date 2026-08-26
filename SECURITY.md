# Security Policy

## Supported versions

Pi Bot is pre-1.0. Security fixes are applied to the latest release and the `main` branch.

## Report a vulnerability

Use GitHub's **Security → Report a vulnerability** flow for this repository. Do not open a public issue for an unpatched vulnerability.

Include:

- Affected version or commit.
- Reproduction steps.
- Impact and required preconditions.
- Any suggested mitigation.

## Trust boundary

Pi extensions execute as trusted local code with the user's operating-system permissions. Pi Bot and pi-subagents are not operating-system sandboxes.

Pi Bot reduces accidental authority by:

- Shipping no default agents.
- Requiring explicit tool lists.
- Denying recursive orchestration tools.
- Separating generated behavior text from runtime capabilities.
- Confirming elevated tools before each run.
- Storing state outside repositories with restrictive permissions.
- Avoiding credentials, transcripts, and tool output in its state. Profile text and task receipts are stored verbatim and must not contain secrets.

Users remain responsible for the models, tools, extensions, repositories, and credentials they enable.
