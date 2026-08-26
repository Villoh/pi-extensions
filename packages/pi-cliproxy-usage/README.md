# pi-cliproxy-usage

Compact CLIProxyAPI account usage meters for Pi Coding Agent.

Shows one colored line below editor per enabled account of the active model's provider:

```text
● Claude   │ user │ S ━━━━━━━─── 70%  │  W ━━━━────── 40%
● Codex    │ user │ S ━━━━━━━━━─ 90%
● DeepSeek │ team │ 9.99 USD
```

Percentages and filled bars show usage **consumed**. Colors shift green → yellow at 70% → red at 90%. Codex shows Session (5-hour window) and Weekly (7-day window), same as Claude. DeepSeek reports remaining account balance instead of a percentage.

## Requirements

- [Pi Coding Agent](https://github.com/earendil-works/pi)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) with its Management API enabled (`remote-management.secret-key` set) and at least one Claude, Codex, Grok, or DeepSeek account configured

## Install

From npm:

```bash
pi install npm:pi-cliproxy-usage
```

After installing or updating, run `/reload` in Pi.

Try it without installing:

```bash
pi -e npm:pi-cliproxy-usage
```

Or from a local checkout, useful while developing:

```bash
pi install /absolute/path/to/pi-cliproxy-usage
# or, without installing, from this package directory:
pi -e ./index.ts
```

## Management setup

Run the interactive setup command after installation:

```text
/cliproxy-usage setup
```

The extension reads `<getAgentDir()>/cliproxyapi.json` and reuses its `baseUrl`. Both CLIProxyAPI forms accepted by the provider are supported: a root URL such as `http://127.0.0.1:8317` and the same URL ending in `/v1`; trailing slashes are ignored and reverse-proxy path prefixes are preserved. It then displays a masked password prompt for the password used by CLIProxyAPI's `management.html`, validates it against `/v0/management/auth-files`, and saves it only after validation succeeds.

The password is stored as `managementKey` in `pi-cliproxy-usage.json`. This file is written with mode `0600`; `/cliproxy-usage status` only reports whether the key is configured and never prints it. CLIProxyAPI stores its own `remote-management.secret-key` as a bcrypt hash, so the original password cannot be recovered from the server's YAML config.

`managementUrl` is normally empty. Set it through `/cliproxy-usage settings` only when the management endpoint differs from the provider base URL, for example when using a private SSH tunnel while inference uses a public address. Enter the CLIProxyAPI root URL; a trailing `/v0/management` is accepted and normalized.

CLIProxyAPI requires a valid management key even for localhost. Direct LAN or public access also requires remote management to be enabled on the server. The extension preserves the configured Management URL protocol and does not rewrite or warn about HTTP versus HTTPS.

The extension uses only the Management API as its account source. It lists OAuth accounts through `/v0/management/auth-files`. DeepSeek entries are discovered through `/v0/management/openai-compatibility` by requiring the exact `api.deepseek.com` hostname and retaining only each entry's `auth-index`; returned API key fields are never logged, persisted, or forwarded by the extension. The server then calls official quota/balance endpoints through `/v0/management/api-call`. These quota HTTP requests do not consume LLM input/output tokens. Refreshes query only the active Pi model's matching provider, cache the result for model switching, and refresh stale provider data on demand. The default automatic refresh interval is five minutes.

After a 401 or 403, automatic retries stop for the rejected password to avoid CLIProxyAPI's temporary ban after repeated authentication failures. Run `/cliproxy-usage setup` again after changing the password.

## Settings

User file: `<getAgentDir()>/pi-cliproxy-usage.json` (normally `~/.pi/agent/pi-cliproxy-usage.json`). Missing file uses defaults. Changes from interactive UI apply immediately. Settings reload on session start and `/reload`.

Older `~/.pi/agent/extensions/pi-cliproxy-usage/config.json` files migrate automatically when the canonical file does not exist.

```json
{
  "managementUrl": "",
  "selectionMode": "auto",
  "refreshMinutes": 5,
  "maxVisibleAccounts": 4,
  "providers": {
    "claude": true,
    "codex": true,
    "grok": true,
    "deepseek": true
  },
  "accounts": {},
  "hideEmails": false
}
```

`managementKey` also lives in this file once `/cliproxy-usage setup` succeeds, but it isn't shown in `/cliproxy-usage settings` — manage it with `setup`/`login`/`logout` instead.

`selectionMode` is `auto` by default: it follows the active Pi model and refreshes only its matching provider. Set it to `manual` to refresh all enabled providers. `providers` toggles providers on or off in either mode. In `/cliproxy-usage settings`, `accounts` lets you enable/disable individual Management API accounts by stable `auth_index`; these account toggles apply in manual mode. `hideEmails` restores masking such as `j***@***.com` in the widget and detail notifications. Accepted values: `managementUrl` is a string (empty means reuse `baseUrl`); `refreshMinutes` and `maxVisibleAccounts` are integers of at least `1`; provider and account values are booleans. The widget prioritizes errors, then accounts with the least remaining quota or balance, and shows an overflow row when more accounts exist. Invalid setting values are ignored with a warning. Unknown fields are preserved when saving. Only the retired local path field (`accountsDir`) is removed on save.

## Commands

- `/cliproxy-usage` — refresh and show quota for the current model
- `/cliproxy-usage setup` — enter, validate, and save the Management API password
- `/cliproxy-usage login` — alias for setup
- `/cliproxy-usage logout` — remove the saved Management API password
- `/cliproxy-usage settings` — choose auto/manual selection, choose providers/accounts, toggle email masking, and edit refresh settings
- `/cliproxy-usage status` — show effective URLs, settings warnings, and the current provider's last refresh time

Setup, settings, and status also print the CLIProxyAPI web dashboard URL (`<root>/management.html`) when a root resolves. It only loads when the server's `remote-management.disable-control-panel` is `false` (or unset) — with it `true`, CLIProxyAPI skips downloading `management.html` and the page 404s.

- `/cliproxy-usage help` — show commands and manual settings path

Detailed quota notifications (`/cliproxy-usage refresh`, `/cliproxy-usage`) include the provider reset countdown when the upstream API supplies a reset timestamp. The compact widget intentionally omits reset times.

If an upstream provider quota request returns 401 or 403, let CLIProxyAPI refresh the account or log in again.

## Support

Report bugs and request features in [GitHub Issues](https://github.com/Villoh/pi-extensions/issues).
