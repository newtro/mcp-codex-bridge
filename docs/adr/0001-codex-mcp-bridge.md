# ADR 0001: Codex MCP Bridge Design

Date: 2026-05-20
Status: Accepted

## Context

The goal is an MCP server that lets Claude Code call Codex inline as a critic, second opinion, or implementer for specific subtasks. The user has a ChatGPT Plus subscription and wants to use that subscription auth, keeping per-token cost at zero.

## Prior Art Evaluation

Searched npm and GitHub for existing Codex MCP servers in May 2026.

| Project | Approach | Tools | Fit for this use case |
|---------|----------|-------|------------------------|
| `codex-mcp-server` (tuannvm, v1.4.10) | Subprocess to Codex CLI | `codex`, `review`, `websearch`, `listSessions`, `ping`, `help` | Close, with general-purpose session management focus |
| `codex mcp-server` (built-in Codex subcommand) | Codex CLI exposes itself as an MCP server | Codex's agentic surface as a single tool | Too coarse-grained for inline second-opinion calls |
| `claude-codex-dialog` (LobeHub) | Older proof of concept | Limited | Stale |

`tuannvm/codex-mcp-server` is the closest existing project. Its tool surface centers on long-running sessions with model selection. The brief here is different: focused single-shot calls from Claude Code with sandbox defaults that vary per tool, structured error classes with actionable remediation text, and ChatGPT-subscription auth only.

A fresh implementation is cheaper than carving down the existing project and lets the error and logging layer be designed for the four-tool shape from the start.

## Decision: Subprocess to `codex exec --json`

The user's auth lives in the Codex CLI's stored credentials (browser OAuth flow against ChatGPT Plus). The OpenAI Responses or Chat Completions API was rejected because it would require an API key the user does not want to provision and would bill against a different budget. Subprocess to the CLI keeps auth out of this package entirely; the CLI handles token refresh and subscription routing.

Trade-off: subprocess start-up cost on every call (cold start of the Codex CLI, typically a few hundred milliseconds). Acceptable because these are inline calls from another agent for occasional second opinions and reviews, well outside a hot path.

Codex CLI 0.132.0 supports `codex exec --json`, which emits JSONL events to stdout including the final assistant message. That gives a parseable interface to structured output without screen-scraping a TUI.

## Decision: Four focused tools

| Tool | Purpose | Default sandbox |
|------|---------|------------------|
| `codex_status` | Health check: version, auth state, default model | n/a (CLI introspection only) |
| `codex_ask` | General second-opinion or analysis query | `read-only` |
| `codex_review` | Adversarial review of a diff or file | `read-only` |
| `codex_implement` | Codex produces an implementation against a spec | `workspace-write` |

Each tool has its own input schema (zod raw shape), prompt composition, and sandbox default. This is narrower than tuannvm's six-tool surface, which is intentional: the consumer is another LLM agent, and a smaller surface area means less confusion about which tool to pick.

`workspace-write` is reserved for `codex_implement` because that is the only tool whose explicit purpose is mutating files. `codex_status`, `codex_ask`, and `codex_review` stay read-only so that an accidental misuse cannot mutate the workspace.

## Decision: Error classification with actionable remediation

Every subprocess invocation maps its failure to one of a small set of error classes, and every error carries a `userAction` string that tells the calling agent what to do next.

Classes:

- `CODEX_NOT_FOUND` (spawn ENOENT). `userAction`: install Codex CLI per https://github.com/openai/codex or set `CODEX_CLI_PATH`.
- `CODEX_NOT_AUTHENTICATED`. `userAction`: run `codex login` to sign in with ChatGPT.
- `CODEX_RATE_LIMITED`. `userAction`: wait and retry, or check ChatGPT subscription status.
- `CODEX_TIMEOUT`. `userAction`: retry with a larger `CODEX_MCP_TIMEOUT_MS` or break the request into smaller steps.
- `CODEX_PARSE_ERROR`. `userAction`: enable debug logging to capture raw stderr; Codex CLI may have changed output format.
- `CODEX_FAILED`. `userAction`: read the surfaced stderr; the wrapper does not interpret what went wrong.

The rationale is that the calling agent reads the error response and decides whether to retry, fall back, or surface to the human. Generic "subprocess failed with exit code 1" is useless to an agent. Specific class plus remediation lets the agent choose intelligently.

## Decision: Structured stderr logging

Every invocation writes one JSON line to stderr with `{ ts, tool, durationMs, exitCode, errorClass, argSummary }`. The MCP host (Claude Code) captures stderr and surfaces it through `/mcp` for diagnostics. JSON lines let downstream log aggregators parse it without a custom format.

Stdout is reserved for the MCP protocol itself (this is a stdio transport).

## Decision: Stack

- TypeScript with `tsc` compilation to ESM, Node 20+.
- `@modelcontextprotocol/sdk` ^1.24 (currently resolves to 1.29) for the MCP server primitives. Validated against the installed type definitions before adopting.
- `zod` ^3.25 for input validation. The SDK's `registerTool` accepts a Zod raw shape directly.
- `vitest` for tests because it integrates cleanly with the TypeScript ESM setup and has a working `vi.mock` for `child_process`.

`zod@^3.25` was chosen over `zod@^4` because the SDK's type definitions declare `ZodRawShapeCompat` against the v3 shape, and the v4 migration would risk subtle type errors that do not surface until call time.

ESM was chosen because the SDK ships ESM-only. CommonJS interop would require a `tsx`-style transform anyway.

## Decision: Distribution

Standalone npm package at `mcp-codex-bridge` (verified available May 2026). MIT license. Single bin entry, so installation via `npx mcp-codex-bridge` works after publish, and a local install via `node /path/to/dist/index.js` works before publish.

The package is intentionally not part of the Archon VS Code extension repo. Other MCP-aware clients (Claude Desktop, Cursor, custom agents) can consume it the same way.
