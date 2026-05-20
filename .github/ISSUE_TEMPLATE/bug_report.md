---
name: Bug report
about: Report a defect in mcp-codex-bridge
title: ''
labels: bug
assignees: ''
---

## What happened

Brief description of the bug.

## How to reproduce

1. ...
2. ...
3. ...

## What you expected

What should have happened instead.

## Environment

- mcp-codex-bridge version (or git SHA):
- Node.js version (`node --version`):
- OS / shell:
- Codex CLI version (`codex --version`):
- Output of `codex_status` (if relevant):

## Relevant logs

The bridge writes JSON lines to its own stderr. Claude Code surfaces these under `/mcp`. Paste the line for the failed call here if you can capture it.

```
{paste log line here}
```
