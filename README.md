# pi-extensions

[![npm scope](https://img.shields.io/badge/npm-@villoh-blue)](https://www.npmjs.com/org/villoh) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

A practical collection of [Pi Coding Agent](https://pi.dev) extensions I use in my daily workflow.

This repository is a small monorepo. Each extension lives in its own package under `packages/` and is published independently, so you only install what you need.

> [!IMPORTANT]
> Pi extensions run with your full user permissions. Review an extension's source before installing it from any third party, including this one.

## Quick start

Install an extension permanently:

```bash
pi install npm:@villoh/pi-tools
```

Try one without adding it permanently:

```bash
pi -e npm:@villoh/pi-tools
```

Combine multiple extensions:

```bash
pi -e npm:@villoh/pi-tools -e npm:@villoh/pi-skills-manager
```

## Packages

| Package | Version | Description | Install |
| --- | --- | --- | --- |
| [`@villoh/pi-auto-name-session`](packages/pi-auto-name-session) | [![npm](https://img.shields.io/npm/v/@villoh/pi-auto-name-session)](https://www.npmjs.com/package/@villoh/pi-auto-name-session) | Replaces Pi's default first-message session label with a short generated title. | `pi install npm:@villoh/pi-auto-name-session` |
| [`@villoh/pi-btw`](packages/pi-btw) | [![npm](https://img.shields.io/npm/v/@villoh/pi-btw)](https://www.npmjs.com/package/@villoh/pi-btw) | Adds `/btw`, a parallel side conversation with its own Pi sub-session, tools, model settings, and handoff commands. | `pi install npm:@villoh/pi-btw` |
| [`pi-cliproxy-usage`](packages/pi-cliproxy-usage) | [![npm](https://img.shields.io/npm/v/pi-cliproxy-usage)](https://www.npmjs.com/package/pi-cliproxy-usage) | Displays compact CLIProxyAPI account usage meters for Claude, Codex, and Grok accounts. | `pi install npm:pi-cliproxy-usage` |
| [`@villoh/pi-extensions-manager`](packages/pi-extensions-manager) | [![npm](https://img.shields.io/npm/v/@villoh/pi-extensions-manager)](https://www.npmjs.com/package/@villoh/pi-extensions-manager) | Adds `/extensions` to enable or disable loaded extensions and reload Pi. | `pi install npm:@villoh/pi-extensions-manager` |
| [`@villoh/pi-skills-manager`](packages/pi-skills-manager) | [![npm](https://img.shields.io/npm/v/@villoh/pi-skills-manager)](https://www.npmjs.com/package/@villoh/pi-skills-manager) | Adds `/skills` to list, enable, and disable discovered skills. | `pi install npm:@villoh/pi-skills-manager` |
| [`@villoh/pi-tools`](packages/pi-tools) | [![npm](https://img.shields.io/npm/v/@villoh/pi-tools)](https://www.npmjs.com/package/@villoh/pi-tools) | Adds `/tools` to enable or disable individual tools during the current session. | `pi install npm:@villoh/pi-tools` |

> `pi-cliproxy-usage` keeps its original unscoped name because it's already published under it. Every other package moved to the `@villoh` npm scope to avoid clashing with unrelated packages that already existed under the unscoped name.

## Development

```bash
npm install
npm run check   # lint (biome) + each package's own check script
npm run test    # each package's own test script
```

### Releasing

Versioning and npm publishing are automated with [Changesets](https://github.com/changesets/changesets). After a change that should ship:

```bash
npm run changeset   # describe the change and pick a semver bump, per affected package
```

Merging to `main` lets the [Release workflow](.github/workflows/release.yml) open a "Version Packages" PR; merging that PR publishes the bumped, non-private packages to npm.

## License

Each package keeps its own license. The repository scaffolding and original extensions are MIT.
