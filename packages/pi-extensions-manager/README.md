# Pi Extensions Manager

Adds `/extensions`, a TUI selector for enabling or disabling loaded user/project extensions.

Changing a value updates Pi's `settings.json` resource filters and reloads extensions in the current process. Pi's own extension manager stays enabled.

The selector keeps a small registry in `~/.pi/agent/pi-extension-manager.json`, so disabled extensions remain available to re-enable. Pi does not expose a public list of hook-only extensions, so an extension must have exposed a command or tool at least once to enter the registry.

## Install

From npm:

```bash
pi install npm:@villoh/pi-extensions-manager
```

Try it without installing:

```bash
pi -e npm:@villoh/pi-extensions-manager
```

Or from a local checkout, useful while developing:

```bash
pi install /absolute/path/to/pi-extensions-manager
# or, without installing:
pi -e /absolute/path/to/pi-extensions-manager
```

## Commands

- `/extensions` — open the selector (all extensions, editable)
- `/extensions list` — list all extensions without editing
- `/extensions list enabled` — list only enabled extensions
- `/extensions list disabled` — list only disabled extensions

## License

[MIT](LICENSE)
