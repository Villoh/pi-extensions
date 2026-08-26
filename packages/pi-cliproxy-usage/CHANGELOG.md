# pi-cliproxy-usage

## 0.4.0

### Minor Changes

- 7cede3b: Switch quota discovery to CLIProxyAPI's Management API instead of reading local auth files. Add `/cliproxy-usage setup` (alias `login`) and `/cliproxy-usage logout` to enter and validate a masked Management API password, stored as `managementKey`, in a bordered/titled prompt matching `/cliproxy-usage settings` and with working paste support. Add a `managementUrl` override setting for management endpoints that differ from the provider base URL. Add DeepSeek balance support, discovered through `/v0/management/openai-compatibility`. Show the CLIProxyAPI web dashboard URL (`<root>/management.html`) in setup, settings, and status. Refreshes now scope to the active model's matching provider and cache results across model switches. The retired local auth path setting (`accountsDir`) is dropped on save; Management API account selection is available in manual mode, and email masking remains available. Fix silent background refreshes (session start, `/new`, `/reload`, model switches, the periodic timer) repeatedly popping a "Management password not configured" toast; that warning now only shows for an explicit `/cliproxy-usage` or `/cliproxy-usage refresh`.

## 0.3.0

### Minor Changes

- 0411917: Add a "Hide emails" toggle in `/cliproxy-usage settings` that masks account emails, including the domain (e.g. `j***@***.com`), everywhere labels are shown, so screen-sharing doesn't expose them.
- 2bd42e9: Add per-account enable/disable toggles in `/cliproxy-usage settings`, so you can pick which discovered accounts to use within an enabled provider instead of only enabling or disabling an entire provider.

## 0.2.6

### Patch Changes

- 209c79b: Show Codex's weekly (7-day) usage window again, now that OpenAI restored the 5-hour rate limit window. Session continues to track the 5-hour window; weekly is no longer omitted.
