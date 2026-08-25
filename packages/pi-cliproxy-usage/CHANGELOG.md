# pi-cliproxy-usage

## 0.3.0

### Minor Changes

- 0411917: Add a "Hide emails" toggle in `/cliproxy-usage settings` that masks account emails, including the domain (e.g. `j***@***.com`), everywhere labels are shown, so screen-sharing doesn't expose them.
- 2bd42e9: Add per-account enable/disable toggles in `/cliproxy-usage settings`, so you can pick which discovered accounts to use within an enabled provider instead of only enabling or disabling an entire provider.

## 0.2.6

### Patch Changes

- 209c79b: Show Codex's weekly (7-day) usage window again, now that OpenAI restored the 5-hour rate limit window. Session continues to track the 5-hour window; weekly is no longer omitted.
