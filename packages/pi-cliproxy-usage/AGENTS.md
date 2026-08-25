# AGENTS.md

## Scope

Pi extension showing CLIProxyAPI account usage. Keep changes small, typed, and dependency-free unless clearly necessary.

## Architecture

- `index.ts`: Pi lifecycle and command wiring only.
- `src/config.ts`: persisted configuration.
- `src/config-ui.ts`: interactive TUI configuration.
- `src/usage.ts`: account discovery and provider HTTP requests.
- `src/parsers.ts`: pure provider response parsing.
- `src/ui.ts`: formatting and widget rendering.
- `src/types.ts`: shared types.
- `test/`: TypeScript tests using `node:test`.

Preserve these boundaries. Put pure logic outside `index.ts` and cover it with focused tests.

## Commands

```bash
npm install
npm test
npm run check
pi -e ./index.ts
npm pack --dry-run
```

## Testing

- Run `npm test` and `npm run check` before committing.
- Add or update tests for behavior changes and bug fixes.
- Avoid real provider requests in tests. Use pure parsers, temporary files, or mocked `fetch`.
- Keep tests deterministic and independent of user credentials/configuration.

## Git and PRs

- Features and bug fixes require an issue, focused branch, and PR.
- Link feature and fix PRs to their issue, preferably with `Closes #123`.
- Small documentation, test, refactor, chore, and release changes may commit directly to `main`; use a PR only when review adds value.
- Create focused branches when using a PR: `feat/...`, `fix/...`, `refactor/...`, `test/...`, `chore/...`.
- Keep commits atomic. Do not mix unrelated cleanup with feature changes.
- Before pushing, ensure relevant tests and type checks pass.
- PR descriptions should state what changed, why, and how it was verified.

## Conventional Commits

Use lowercase Conventional Commit subjects:

```text
feat: add provider toggle
fix: classify codex session window
refactor: split usage client modules
test: cover malformed auth files
docs: document configuration path
chore: update pi dependencies
```

Use `!` and a `BREAKING CHANGE:` footer only for actual breaking changes.

## Constraints

- Credentials must stay local and only go to official provider endpoints.
- Never log or expose access/refresh tokens.
- Configuration path: `~/.pi/agent/extensions/pi-cliproxy-usage/config.json`.
- Keep `/cliproxy-usage` as command entry point; use subcommands for additional actions.
