# Security Policy

## Supported Versions

Active development happens on `main`. Released versions track `0.x` while the API stabilises; any version on the `main` branch receives security fixes. Older tagged versions do not.

| Version | Supported |
|---------|-----------|
| `main`  | yes |
| `0.x`   | yes (latest minor only) |

## Reporting a Vulnerability

Please report vulnerabilities privately. Do not open a public issue for security problems.

Use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/newtro/mcp-codex-bridge/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, including reproduction steps and any proof-of-concept.

Expect an initial acknowledgement within 7 days and a fix or mitigation plan within 30 days for confirmed issues.

## Scope

This server invokes the Codex CLI as a subprocess and exposes the result via MCP. Relevant security boundaries:

- **Subprocess arguments** are passed as an array, never via shell. User-supplied strings flow as argv values only; prompt content goes via stdin.
- **Auth credentials** live in the Codex CLI (`~/.codex/`). This server never reads, writes, or transmits them.
- **Sandbox enforcement** is the Codex CLI's responsibility. The server forwards `--sandbox` per tool; the default for `codex_implement` is `workspace-write` and for `codex_ask` / `codex_review` is `read-only`.
- **Logs** record argument summaries and timings to stderr. Prompt content is never logged; only its character count.

Out of scope:

- Vulnerabilities in the Codex CLI itself (report upstream at https://github.com/openai/codex).
- Vulnerabilities in `@modelcontextprotocol/sdk` (report upstream at https://github.com/modelcontextprotocol/typescript-sdk).
