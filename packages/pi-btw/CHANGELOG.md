# @villoh/pi-btw

## 0.6.0

### Minor Changes

- c8ea201: Add slash-command completion in the BTW composer for `/btw` and `/side` subcommands
- 3619e72: Add opt-in extension tools for `/btw` children via a `btw.json` allowlist, and state the child's real tool set in its system prompt
- 00c76a8: Port upstream overlay UX: Markdown rendering, abort-first Esc while streaming, `Alt+w` full-width toggle, and `PI_BTW_FOCUS_KEYS`/`Super+/` focus shortcuts; stop double-closing stacked overlays and leave fullscreen mouse reporting to pi
- b0dc877: Add `/btw readonly` (read/grep/find/ls only) and the `/side` alias for `/btw`
- 711ef26: Add opt-in SSH workspaces (`"workspace": "ssh"` in `btw.json`) so BTW children run their file and shell tools on the parent's pi-ssh-remote host

### Patch Changes

- 24ef8b2: Don't count aborted or failed replies in the overlay's exchange counter
- c5f7515: Fix contextual `/btw` on Pi 0.87+ (seed the child session manager) and the Anthropic `tool_addition/tool_removal references unknown tool` 400 on Pi 1.1+
- f0434f0: Accept subscription/OAuth and keyless model auth in `/btw` instead of requiring an API key
- ef06bca: Declare Pi peer dependency range `>=0.85.1 <2` and develop against Pi 0.99.2
- 265244f: Show `/btw` answers as session notes on RPC/SDK hosts instead of silently failing to open the overlay
- a1d0ee4: Add end-to-end tests against the real Pi SDK and a `check` script

## 0.5.1

### Patch Changes

- fce1401: Add `pi-extension`/`pi-skill` keywords so the pi.dev package gallery shows the correct EXTENSION/SKILL badge instead of the generic PACKAGE fallback.
