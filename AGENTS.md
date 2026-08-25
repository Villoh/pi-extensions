# AGENTS.md

## Scope

Monorepo of independent [Pi Coding Agent](https://pi.dev) extensions. Each package under `packages/*` has its own name, version, and npm publish state (some are `private: true` and never publish). Package-specific `AGENTS.md` files, when present, take precedence over this file for that package's internals; this file covers monorepo-wide conventions, especially versioning and releases.

## Layout

```text
packages/<name>/package.json   # own name, version, private flag
.changeset/*.md                # pending version bumps, one file per change
.github/workflows/ci.yml        # lint + check + test on push/PR
.github/workflows/release.yml   # changesets: version PR, then publish
biome.json                      # root lint/format config (applies repo-wide)
```

## Commands

```bash
npm install
npm run lint     # biome check .
npm run format   # biome format --write .
npm run check    # lint + each package's own "check" script
npm run test     # each package's own "test" script
```

Run `check` and `test` before every commit that touches `packages/`.

## Versioning and releases (Changesets)

Versioning is per package, driven by [Changesets](https://github.com/changesets/changesets). Never hand-edit a `version` field in a package's `package.json` — Changesets owns it.

### When your change touches a package under `packages/*`

1. Finish the code change.
2. Run `npm run changeset` and:
   - Select every package whose published behavior changed (not packages you only touched incidentally, e.g. shared config formatting).
   - Pick the bump per package:
     - **patch** — bug fix, internal refactor, dependency bump, doc/test-only change with no behavior change for users.
     - **minor** — new command, new option, new capability, anything additive that does not break existing usage.
     - **major** — removed or renamed a command/setting/config key, changed a config file format, changed default behavior a user would notice as broken, or anything requiring the user to change how they use the extension.
   - Write the summary as a changelog entry (user-facing, one line, imperative: `Add --dry-run flag to /tools list`).
3. Commit the generated `.changeset/*.md` file together with the code change, in the same PR/commit.
4. Skip this step only for changes with zero effect on any published package (CI config, this file, root tooling) — those never need a changeset.

A single PR can contain changesets for multiple packages, each with its own bump level.

### What happens after merge to `main`

`release.yml` runs `changesets/action` on every push to `main`:

- **Pending changesets exist** → it opens/updates a `chore(release): version packages` PR. That PR bumps `version` and writes `CHANGELOG.md` only for the packages that had changesets, consumes (deletes) those `.changeset/*.md` files, and leaves every other package untouched.
- **No pending changesets** (i.e. that version PR was just merged) → it runs `changeset publish`, which publishes **only** the packages whose `version` no longer matches what's live on npm, and skips any package with `private: true`. Each package gets its own npm publish and its own git tag; nothing is published in lockstep.

So the loop is always: code change + changeset → merge → review the auto-generated version PR → merge that → npm publish happens automatically, scoped to exactly the packages that changed.

### Rules

- Do not manually publish (`npm publish`) or manually bump `version` — always go through a changeset.
- Do not add a changeset for a package that is `private: true` unless you are also flipping it to public in the same change; private packages never get published.
- `pi-cliproxy-usage` is intentionally unscoped (published before the `@villoh` scope existed). Every other new package must publish under `@villoh/<name>`.

## Git and PRs

- Focused branches: `feat/...`, `fix/...`, `refactor/...`, `test/...`, `chore/...`.
- Small documentation, test, refactor, chore changes may commit directly to `main`; use a PR when review adds value.
- Keep commits atomic; don't mix unrelated packages or unrelated cleanup in one commit.

## Conventional Commits

```text
feat: add --dry-run flag to /tools list
fix: classify codex session window
refactor: split usage client modules
test: cover malformed auth files
docs: document release flow
chore: update pi dependencies
```

Use `!` and a `BREAKING CHANGE:` footer only when the commit also carries a `major` changeset.
