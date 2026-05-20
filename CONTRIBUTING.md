# Contributing

Thanks for considering a contribution. This project is small enough that the process is light:

1. Open an issue describing the change before sending a PR for anything non-trivial. Bug fixes can skip this step.
2. Fork, branch from `main`, push your branch, open a PR against `main`.
3. CI must pass on Node 20 and 22 across Linux, macOS, and Windows.
4. Keep the style rules: no em dashes, no antithesis constructions ("X, not Y"), comments explain WHY not WHAT, errors include an actionable next step.
5. Add or update tests for behavior changes. The unit suite runs in ~330 ms; please keep it fast.
6. Update `docs/manual-verification.md` by running `node tests/manual-verify.mjs` if you change anything in `src/tools/` or `src/codex-runner.ts`.

## Local development

```bash
npm install
npm run build      # tsc
npm test           # unit suite, mocked subprocess
npm run test:integration   # against real Codex CLI; requires sign-in
```

## Commit messages

Conventional-commit prefixes preferred: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`. Subject line under ~70 characters.

## License

By contributing, you agree your contribution is licensed under the project's MIT license.
