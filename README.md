<p align="center">
  <img src="assets/banner.png" alt="MCP Codex Bridge" width="100%" />
</p>

# mcp-codex-bridge

An MCP server that wraps subscription-authenticated coding CLIs as callable tools, so Claude Code (or any MCP-aware client) can invoke them inline as a critic, second opinion, or implementer. Two backends ship today: the [Codex CLI](https://github.com/openai/codex) and [Grok Build](https://docs.x.ai/build/cli/reference). Both run on your existing subscription auth through their own CLI; no API key required, no per-token cost.

## Why this exists

Upping the ante on **The Adversarial Audit**. The original argument: every agentic workflow needs a second agent breaking the first one's work. The sharper version: that critic should come from a totally different provider. Claude reviewing Claude shares too much training DNA to catch what matters. Codex reviewing Claude catches what same-family review rubber-stamps. This server wires up the handoff so it happens as a tool call inside one session.

With more than one backend the argument extends: independent reviewers only give you evidence if they cannot see each other, and their findings only reconcile cheaply if they come back in the same shape. That is what `structured: true` is for.

Background reading: [Wiring Agents to Each Other](https://open.substack.com/pub/jnycode/p/wiring-agents-to-each-other?r=3x6reh&utm_campaign=post&utm_medium=web&showWelcomeOnShare=true) on the 42 Insights Substack.

## What it gives Claude Code

Each provider registers the same four tools under its own prefix, so a caller fans out by naming them directly and the choice of backend is visible in the transcript.

| Tool | What it does | Sandbox |
|------|---------------|---------|
| `codex_status` / `grok_status` | Reports CLI version, sign-in state, default model, and configured timeout. Use to fail fast before expensive calls. | n/a |
| `codex_ask` / `grok_ask` | General-purpose query for a second opinion or analysis. Optional context files are prepended to the prompt. | `read-only` |
| `codex_review` / `grok_review` | Adversarial review of a diff or file content. Markdown BLOCKER / MAJOR / MINOR by default, or machine-readable JSON findings with `structured: true`. | `read-only` |
| `codex_implement` / `grok_implement` | Hands the CLI a spec and a working directory; it makes the edits itself. | `workspace-write` |

### Provider differences worth knowing

| | Codex | Grok Build |
|---|---|---|
| Prompt transport | stdin | temp file via `--prompt-file` (no stdin path for single-turn runs) |
| Output | streaming JSONL events | one JSON object at the end |
| Native JSON Schema | no, contract held by the prompt | yes, via `--json-schema`; returns a parsed object |
| Per-call reasoning effort | no, config file only | yes, `reasoning_effort` |
| Read-only enforcement | CLI sandbox | CLI sandbox **plus** a tool allowlist, see below |

**Grok read-only runs.** Grok's `--sandbox` is implemented with Landlock (Linux) and Seatbelt (macOS). On Windows the profile cannot be applied and the documented behavior is to warn and continue unenforced; an unrecognised profile name is also accepted silently. So the bridge does not rely on it. Read-only runs additionally pass `--tools read_file,grep,list_dir` and deny `search_replace,run_terminal_cmd,search_tool,use_tool,Agent`. Tool filtering happens inside the CLI and is platform-independent. The `search_tool`/`use_tool` denial matters because the allowlist alone was observed leaving the MCP pair in place on Grok Build 1.0.4, which would be a write path on any host with a write-capable MCP server configured.

## Requirements

- Node.js 20 or newer.
- At least one backend CLI installed and signed in:
  - **Codex**: verify with `codex login status`; it should report `Logged in using ChatGPT`. Needs a ChatGPT Plus account or equivalent.
  - **Grok Build**: verify with `grok models`; it should report `You are logged in`. Needs SuperGrok or X Premium+. Install with `curl -fsSL https://x.ai/cli/install.sh | bash` (works under Git for Windows bash). The installer does **not** add `~/.grok/bin` to PATH on Windows, so set `GROK_CLI_PATH`.

Providers are independent. A missing or signed-out CLI only affects its own tools; every call returns a structured error naming the exact command to run.

## Install

```bash
git clone https://github.com/newtro/mcp-codex-bridge.git
cd mcp-codex-bridge
npm install
npm run build
```

The build produces `dist/index.js` with a shebang, ready to be invoked as a CLI.

## Wire it into Claude Code

Claude Code reads MCP servers from `~/.claude.json`. Add this server at **user scope** so it loads in every project:

```bash
# Linux / macOS
claude mcp add-json --scope user codex-bridge \
  '{"type":"stdio","command":"node","args":["/absolute/path/to/mcp-codex-bridge/dist/index.js"]}'

# Windows (PowerShell). Note JSON-escaped backslashes.
claude mcp add-json --scope user codex-bridge `
  '{"type":"stdio","command":"node","args":["D:\\Repos\\mcp-codex-bridge\\dist\\index.js"]}'
```

Verify:

```bash
claude mcp list
# expect: codex-bridge: node /absolute/path/to/dist/index.js
```

In any Claude Code session, all eight tools (`codex_*` and `grok_*`) appear under the `codex-bridge` server.

To use the Grok backend on Windows, point the server at the binary, since the installer leaves `~/.grok/bin` off PATH:

```json
{
  "mcpServers": {
    "codex-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["D:\\Repos\\mcp-codex-bridge\\dist\\index.js"],
      "env": {
        "GROK_CLI_PATH": "C:\\Users\\you\\.grok\\bin\\grok.exe"
      }
    }
  }
}
```

### Alternative: Claude Desktop / generic JSON config

If your client uses a `claude_desktop_config.json`-style file, drop the same entry into its `mcpServers` block:

```json
{
  "mcpServers": {
    "codex-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-codex-bridge/dist/index.js"]
    }
  }
}
```

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CODEX_CLI_PATH` | `codex` (resolved on PATH) | Override the Codex binary location, useful when the CLI is installed outside PATH. |
| `CODEX_MCP_TIMEOUT_MS` | `300000` (5 minutes) | Default per-call timeout for Codex tools. Per-call `timeout_ms` overrides this. |
| `CODEX_HOME` | `~/.codex` | Directory where Codex stores its `config.toml` and credentials. The bridge reads the configured default model from `$CODEX_HOME/config.toml`. |
| `GROK_CLI_PATH` | `grok` (resolved on PATH) | Override the Grok binary location. Usually required on Windows, where the installer leaves `~/.grok/bin` off PATH. |
| `GROK_MCP_TIMEOUT_MS` | `300000` (5 minutes) | Default per-call timeout for Grok tools. Per-call `timeout_ms` overrides this. |
| `GROK_HOME` | `~/.grok` | Directory where Grok stores its `config.toml`. The bridge reads the default model from the `[models]` section. |

## Tool reference

`<p>` below stands for `codex` or `grok`. The input shapes are identical across providers; `reasoning_effort` is accepted everywhere but ignored by Codex, which takes effort from its config file only.

### `<p>_status`

No inputs. Returns plain text with CLI version, auth state, default model, default timeout, and warnings if the CLI is missing or not signed in.

The `Default model` is read from the provider's own config (`~/.codex/config.toml`, or the `[models]` section of `~/.grok/config.toml`) or from the auth probe itself. The bridge does not interpret or validate it.

### `<p>_ask`

```json
{
  "prompt": "string (required)",
  "working_directory": "optional cwd",
  "context_files": ["optional paths read and prepended to the prompt; truncated at 64 KiB each"],
  "model": "optional model override",
  "reasoning_effort": "optional; grok only",
  "timeout_ms": "optional per-call timeout in ms"
}
```

Read-only sandbox. Safe for analysis questions, design discussions, and any prompt where the CLI must not touch files.

### `<p>_review`

```json
{
  "diff": "string (required) - unified diff or full file content",
  "focus_areas": ["security", "performance", "edge cases"],
  "context": "what the code is trying to do, plus project conventions",
  "structured": "optional bool - return JSON findings instead of markdown",
  "output_schema": "optional JSON Schema string; implies structured",
  "working_directory": "optional cwd",
  "model": "optional model override",
  "reasoning_effort": "optional; grok only",
  "timeout_ms": "optional per-call timeout in ms"
}
```

Asks the CLI to act as an adversarial reviewer. Default output is markdown organised as BLOCKER / MAJOR / MINOR / What I checked but found clean / Verdict.

With `structured: true` the response is instead a JSON object with a `findings` array, each entry carrying `file`, `line`, `severity`, `category`, `evidence`, `issue`, `suggested_fix`, and `confidence`, plus `checked_clean` and `verdict`. Use this whenever more than one reviewer is running: identical shapes make reconciliation mechanical rather than a matter of interpreting three different report formats. Grok constrains decoding to the schema natively; Codex is held to it by the prompt.

`category` is deliberately a free string, not an enum, because the taxonomy belongs to the calling project. Pass `output_schema` to substitute your own contract entirely.

### `<p>_implement`

```json
{
  "spec": "string (required) - description of what to build",
  "working_directory": "string (required) - absolute path of the repo to modify",
  "files_in_scope": ["optional list of files the CLI is encouraged to limit edits to"],
  "approval_mode": "read-only | workspace-write | danger-full-access (default: workspace-write)",
  "model": "optional model override",
  "reasoning_effort": "optional; grok only",
  "timeout_ms": "optional per-call timeout in ms"
}
```

The CLI writes the files itself. `workspace-write` is the default so edits actually land; pass `read-only` if you only want a plan, or `danger-full-access` only when it needs to run package installs or commands beyond the workspace. Write modes pass `--always-approve` to Grok, because a headless run cannot answer an approval prompt and would otherwise block until the timeout.

Every result appends an objective `git diff` probe of the working directory, so the caller has a source of truth independent of the CLI's own account of what it did.

## How error reporting works

Every failure is one of six kinds, namespaced per provider (`CODEX_TIMEOUT`, `GROK_TIMEOUT`) so a caller running several CLIs in parallel can tell which one degraded. Each carries a `userAction` field telling the calling agent what to do next.

| Kind | When it fires | What the agent should do |
|-------|---------------|---------------------------|
| `*_NOT_FOUND` | Binary missing or not executable (ENOENT / EACCES). | Install the CLI, or set `CODEX_CLI_PATH` / `GROK_CLI_PATH`. |
| `*_NOT_AUTHENTICATED` | Stderr indicates "not logged in" / 401 / similar. | Run `codex login` or `grok login`. |
| `*_RATE_LIMITED` | Stderr or event payload contains a rate-limit / 429 / quota message. | Wait and retry, or check plan usage. |
| `*_TIMEOUT` | Subprocess did not complete within the per-call timeout. SIGTERM then SIGKILL after 2 seconds. | Raise the provider's timeout env var or split the request. |
| `*_PARSE_ERROR` | The CLI exited 0 but produced no final assistant message, or its stdout was unparseable. | Check for a CLI upgrade; the bridge may need updating to match a new output schema. |
| `*_FAILED` | Unrecognised non-zero exit. | Read the surfaced stderr for the underlying error. |

An exit code of 0 with no final message is deliberately treated as a failure rather than an empty success, because a silently empty review is indistinguishable from a clean one to the calling agent.

Errors come back as MCP tool results with `isError: true`. The body includes the class tag, the underlying message, the `userAction` string, and any captured stderr.

## Logs

The server writes one JSON object per invocation to its own stderr, tagged with the provider that handled it. Successful calls use `errorClass: "OK"`; everything else uses one of the classes above.

```json
{"ts":"2026-05-20T08:45:35.219Z","provider":"grok","tool":"grok_review","durationMs":12340,"exitCode":0,"errorClass":"OK","argSummary":{"provider":"grok","cwd":null,"sandbox":"read-only","model":null,"reasoningEffort":"high","jsonSchema":"1024 chars","promptChars":1234,"timeoutMs":300000,"skipGitCheck":false,"addDirs":0}}
```

Claude Code surfaces these via `/mcp`. Downstream log aggregators can parse them as JSON lines without a custom format. Prompt content never appears in logs; only the character count.

## Development

```bash
npm install
npm run build              # tsc -> dist/
npm test                   # unit suite (fake spawn; 64 tests in ~350 ms)
npm run test:integration   # exercises a real Codex CLI; requires sign-in
node tests/smoke-tools-list.mjs   # quick MCP-protocol smoke check
node tests/manual-verify.mjs      # exercises the codex tools end-to-end and rewrites docs/manual-verification.md
```

### Adding a provider

Everything shared lives in `src/cli-runner.ts`: spawning, timeout and kill escalation, stream accumulation, error classification, logging. A provider implements only what genuinely differs, via the `CliProvider` interface in `src/providers/types.ts`:

- `buildArgs` for argv
- `preparePrompt` for how the prompt reaches the CLI, including cleanup of anything it writes to disk
- `createParser` for turning stdout into a final message
- `interpretAuthProbe` plus `versionArgs` / `authProbeArgs` for the probes
- capability flags (`supportsJsonSchema`, `supportsReasoningEffort`) that let the runner drop options the CLI cannot honor, instead of passing a flag that silently does nothing

Register it in `src/providers/index.ts` and its four tools appear automatically.

## Manual verification log

A live transcript of all four tools running against a real Codex CLI is at [docs/manual-verification.md](docs/manual-verification.md). It is regenerated by `node tests/manual-verify.mjs` and serves as the proof that the integration is working end to end.

## ADR

Architectural decisions (subprocess over API, four-tool surface, error classification, stack choices, prior art evaluation) are recorded in [docs/adr/0001-codex-mcp-bridge.md](docs/adr/0001-codex-mcp-bridge.md).

## Related reading

- [Wiring Agents to Each Other (42 Insights, Substack)](https://open.substack.com/pub/jnycode/p/wiring-agents-to-each-other?r=3x6reh&utm_campaign=post&utm_medium=web&showWelcomeOnShare=true): the cross-provider adversarial audit argument that motivated this bridge.
- [Model Context Protocol](https://modelcontextprotocol.io): the open standard this server speaks.
- [Codex CLI](https://github.com/openai/codex): one of the upstream tools this bridge wraps.
- [Grok Build CLI](https://docs.x.ai/build/cli/reference): the other.

## License

MIT.
