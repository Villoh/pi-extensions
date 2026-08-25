# Contributing

Contributions are welcome. Keep changes focused, typed, and easy to review.

## Setup

Requirements: Node.js 20+ and Pi Coding Agent.

```bash
git clone git@github.com:Villoh/pi-extensions.git
cd pi-extensions/packages/pi-cliproxy-usage
npm install
```

Run extension locally:

```bash
pi -e ./index.ts
```

## Development

Follow module boundaries documented in [`AGENTS.md`](AGENTS.md). Keep `index.ts` limited to Pi lifecycle and command wiring. Put testable logic under `src/`.

Before submitting changes:

```bash
npm test
npm run check
npm pack --dry-run
```

Add or update tests for behavior changes and bug fixes. Tests belong in `test/`, use TypeScript and `node:test`, and must not depend on real credentials or provider requests.

## Git workflow

1. Open an issue describing the problem, expected outcome, and relevant context before starting a pull request. Small typo or documentation-only fixes may skip this step.
2. Create a focused branch from `main` and reference the issue where practical:

   ```bash
   git switch -c feat/123-short-description
   ```

3. Make one logical change per commit.
4. Use [Conventional Commits](https://www.conventionalcommits.org/):

   ```text
   feat: add provider toggle
   fix: classify codex session window
   refactor: split usage client modules
   test: cover malformed auth files
   docs: document configuration path
   chore: update dependencies
   ```

5. Push branch and open a pull request linked to the issue. Do not commit directly to `main`.

## Pull requests

PR description should include:

- Linked issue (`Closes #123` when merge should resolve it).
- What changed.
- Why change is needed.
- How it was verified.
- Screenshots for visible TUI changes.

Keep PRs small. Avoid unrelated formatting or refactors.

## Security

- Never commit credentials, tokens, account files, or captured provider responses containing private data.
- Never log access or refresh tokens.
- Credentials may only be sent to official provider endpoints.
- Report security issues privately instead of opening a public issue.
