# pi-skills-manager

Adds `/skills`, an interactive selector for enabling and disabling discovered Pi skills.

## Install

From npm:

```bash
pi install npm:@villoh/pi-skills-manager
```

Try it without installing:

```bash
pi -e npm:@villoh/pi-skills-manager
```

Or from a local checkout, useful while developing:

```bash
pi install /absolute/path/to/pi-skills-manager
# or, without installing:
pi -e /absolute/path/to/pi-skills-manager
```

Disabling a skill adds `disable-model-invocation: true` to its `SKILL.md` frontmatter. Enabling it removes that field. Pi reloads resources after a change.

Skills provided by packages or other read-only locations are shown but cannot be changed.

Commands:

- `/skills` — open the selector
- `/skills list [enabled|disabled]` — list skills without editing
- `/skills edit [enabled|disabled]` — edit model invocation visibility
- `/skills <name> [args]` — invoke a skill, equivalent to `/skill:<name> [args]`
- `/skills <name> enable|disable` — change one skill directly
- `/skills config` or `/skills settings` — open the navigable global settings menu
- `/skills config project` — write the same configuration to `.pi/settings.json`

The settings menu edits `enableSkillCommands` and `skills` in `settings.json` without leaving the menu.

Global configuration is stored in `~/.pi/agent/settings.json`. The `project` variant stores it in `<cwd>/.pi/settings.json`, so it applies only to that project after it is trusted.

For example, add these comma-separated paths in the `Skill directories` submenu:

```text
~/.claude/skills, ~/.codex/skills
```

For project-local Claude skills, use `/skills config project` and add:

```text
../.claude/skills
```

## License

[MIT](LICENSE)
