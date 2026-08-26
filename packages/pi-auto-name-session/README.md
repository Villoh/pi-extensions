# pi-auto-name-session

> **This fork** is based on the original [`agnishcc/pi-extention-monorepo`](https://github.com/agnishcc/pi-extention-monorepo/tree/main/packages/edb-auto-name-session) package (`@agnishc/edb-auto-name-session`) by Agnish Chakraborty, republished here under the `@villoh` scope.

A Pi extension that replaces Pi's default first-message session label with a short generated title.

## Install

Install from npm:

```bash
pi install npm:@villoh/pi-auto-name-session
```

Try it without installing:

```bash
pi -e npm:@villoh/pi-auto-name-session
```

Or from a local checkout, useful while developing:

```bash
pi install /absolute/path/to/pi-auto-name-session
# or, without installing:
pi -e /absolute/path/to/pi-auto-name-session
```

## Settings

Open the settings menu with any of these commands:

```text
/auto-name
/auto-name config
/auto-name settings
/auto-name now
```

The menu currently contains the model setting. You can also open it directly:

```text
/auto-name model
/auto-name model provider/model
```

The selection is stored in `~/.pi/agent/pi-auto-name-session.json`. The model selector uses Pi's native keyboard navigation and the current cached model catalog; use `/model` when you need an explicit catalog refresh. When no model is configured, the active model from the current session is used. When the selected model is unavailable or unauthenticated, the extension tries the remaining configured models.

## Behavior

- Runs once per fresh unnamed session.
- Waits until the first user message is recorded.
- `/auto-name now` renames the session from recent user messages, capped at 4,000 characters.
- Generates a concise searchable title.
- Leaves named, resumed, and forked sessions alone.

Configure provider access with `/login` in Pi or the provider's environment variable.

## License

[MIT](LICENSE) © Villoh. Forked from [`agnishcc/pi-extention-monorepo`](https://github.com/agnishcc/pi-extention-monorepo/tree/main/packages/edb-auto-name-session) © Agnish Chakraborty; see [LICENSE](LICENSE) for the original notice.
