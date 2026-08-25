# pi-tools

Adds `/tools`, an interactive selector to enable or disable individual tools for the current session.

Only the enabled tools are exposed to the model; the selection is persisted per session branch, so it survives reloads and follows you across `session_start`/`session_tree` navigation.

## Install

From npm:

```bash
pi install npm:@villoh/pi-tools
```

Try it without installing:

```bash
pi -e npm:@villoh/pi-tools
```

Or from a local checkout, useful while developing:

```bash
pi install /absolute/path/to/pi-tools
# or, without installing:
pi -e /absolute/path/to/pi-tools
```

## Usage

```text
/tools
```

Opens a checklist (TUI mode only) listing every tool from every loaded extension, labeled with the extension it comes from. Toggle a row to enable or disable that tool immediately; the change applies and is saved as soon as you toggle it, no confirm step needed.

## License

[MIT](LICENSE)
