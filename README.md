# mcp-codex-bridge

An MCP server that wraps the [Codex CLI](https://github.com/openai/codex) as four callable tools so Claude Code (or any MCP-aware client) can invoke Codex inline as a critic, second opinion, or implementer. Uses your existing ChatGPT Plus auth via the CLI; no OpenAI API key required.

## What it gives Claude Code

| Tool | What it does | Sandbox |
|------|---------------|---------|
| `codex_status` | Reports CLI version, sign-in state, default model, and configured timeout. Use to fail fast before expensive calls. | n/a |
| `codex_ask` | General-purpose query for a second opinion or analysis. Optional context files are prepended to the prompt. | `read-only` |
| `codex_review` | Adversarial review of a diff or file content. Returns structured BLOCKER / MAJOR / MINOR findings. | `read-only` |
| `codex_implement` | Hands Codex a spec and a working directory; Codex makes the edits itself. | `workspace-write` |

## Requirements

- Node.js 20 or newer.
- Codex CLI installed and signed in. Verify with `codex login status` (it should say `Logged in using ChatGPT`).
- A ChatGPT Plus account or equivalent subscription that Codex CLI is configured against.

If Codex is missing or not signed in, every tool returns a structured error with the exact command to run.

## Install

```bash
git clone https://github.com/sesmith2k/mcp-codex-bridge
cd mcp-codex-bridge
npm install
npm run build
```

The build produces `dist/index.js` with a shebang, ready to be invoked as a CLI.

## Wire it into Claude Code

Claude Code reads its MCP servers from `~/.claude.json`. Add this server at user scope so it is available across every project:

```bash
claude mcp add-json --scope user codex-bridge '{
  "type": "stdio",
  "command": "node",
  "args": ["D:\\Repos\\mcp-codex-bridge\\dist\\index.js"]
}'
```

On macOS or Linux, replace the path with your absolute install path. The user scope writes the entry to `~/.claude.json`'s top-level `mcpServers` block, which loads for every project.

Verify with:

```bash
claude mcp list
# expect: codex-bridge: node /path/to/dist/index.js
```

Then in any Claude Code session, the tools `codex_status`, `codex_ask`, `codex_review`, and `codex_implement` will appear under the `codex-bridge` server.

### Alternative: Claude Desktop / generic JSON config

If your client uses a `claude_desktop_config.json`-style file, the same shape works:

```json
{
  "mcpServers": {
    "codex-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"]
    }
  }
}
```

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CODEX_CLI_PATH` | `codex` (resolved on PATH) | Override the Codex binary location, useful when the CLI is installed outside PATH. |
| `CODEX_MCP_TIMEOUT_MS` | `300000` (5 minutes) | Default per-call timeout. Per-call `timeout_ms` argument overrides this. |
| `CODEX_HOME` | `~/.codex` | Directory where Codex stores its `config.toml` and credentials. Forwarded to Codex via its own resolution. |

## Tool reference

### `codex_status`

No inputs. Returns plain text with version, auth state, default model, default timeout, and warnings if Codex is missing or not signed in.

Use it to fail fast before a long `codex_implement` call, or to diagnose a failure from another tool.

### `codex_ask`

```json
{
  "prompt": "string (required)",
  "working_directory": "optional cwd",
  "context_files": ["optional paths read and prepended to the prompt; truncated at 64 KiB each"],
  "timeout_ms": "optional per-call timeout in ms"
}
```

Read-only sandbox; safe for analysis questions, design discussions, and any prompt where Codex should not touch files.

### `codex_review`

```json
{
  "diff": "string (required) - unified diff or full file content",
  "focus_areas": ["security", "performance", "edge cases"],
  "context": "what the code is trying to do",
  "working_directory": "optional cwd",
  "timeout_ms": "optional per-call timeout in ms"
}
```

Asks Codex to act as an adversarial reviewer. Output is markdown organised as BLOCKER / MAJOR / MINOR / What I checked but found clean / Verdict.

### `codex_implement`

```json
{
  "spec": "string (required) - description of what to build",
  "working_directory": "string (required) - absolute path of the repo to modify",
  "files_in_scope": ["optional list of files Codex is encouraged to limit edits to"],
  "approval_mode": "read-only | workspace-write | danger-full-access (default: workspace-write)",
  "timeout_ms": "optional per-call timeout in ms"
}
```

Codex writes the files itself. `workspace-write` is the default so edits actually land; pass `read-only` if you only want a plan, or `danger-full-access` only when Codex needs to run package installs or out-of-workspace commands.

## How error reporting works

Every failure is one of six classes, each with a `userAction` field telling the calling agent what to do next.

| Class | When it fires | What the agent should do |
|-------|---------------|---------------------------|
| `CODEX_NOT_FOUND` | `codex` binary missing or not executable (ENOENT / EACCES). | Install Codex CLI, or set `CODEX_CLI_PATH`. |
| `CODEX_NOT_AUTHENTICATED` | Codex stderr indicates "not logged in" / 401 / similar. | Run `codex login` to sign in with ChatGPT. |
| `CODEX_RATE_LIMITED` | Stderr or event payload contains a rate-limit / 429 / quota message. | Wait and retry, or check ChatGPT plan usage. |
| `CODEX_TIMEOUT` | Subprocess did not complete within the per-call timeout. SIGTERM then SIGKILL after 2 seconds. | Raise `CODEX_MCP_TIMEOUT_MS` or split the request. |
| `CODEX_PARSE_ERROR` | Codex exited 0 but produced no `agent_message` item, or stdout was unparseable JSONL. | Run `codex --version`; the bridge may need updating to match a new event schema. |
| `CODEX_FAILED` | Unrecognised non-zero exit. | Read the surfaced stderr for the underlying Codex error. |

Errors come back as MCP tool results with `isError: true`. The message body includes the class tag, the underlying message, the `userAction` string, and any captured stderr.

## Logs

The server writes one JSON object per Codex invocation to its own stderr:

```json
{"ts":"2026-05-20T08:45:35.219Z","tool":"codex_review","durationMs":12340,"exitCode":0,"errorClass":"OK","argSummary":{"cwd":null,"sandbox":"read-only","model":null,"promptChars":1234,"timeoutMs":300000,"skipGitCheck":true,"addDirs":0}}
```

Claude Code shows these via `/mcp`. Downstream log aggregators can parse them as JSON lines without a custom format. Prompt content never appears in logs; only the character count.

## Development

```bash
npm install
npm run build       # tsc -> dist/
npm test            # unit suite (mocked subprocess)
npm run test:integration  # real Codex CLI; requires sign-in
node tests/smoke-tools-list.mjs   # quick MCP protocol smoke check
node tests/manual-verify.mjs      # exercises all 4 tools and regenerates docs/manual-verification.md
```

## Manual verification log

A live transcript of all four tools running against real Codex is at [docs/manual-verification.md](docs/manual-verification.md). It is regenerated by `node tests/manual-verify.mjs` and serves as the proof that the integration is working end-to-end.

## ADR

The architectural decisions (subprocess over API, four-tool surface, error classification, stack choices, prior art evaluation) are recorded in [docs/adr/0001-codex-mcp-bridge.md](docs/adr/0001-codex-mcp-bridge.md).

## License

MIT.
