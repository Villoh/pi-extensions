import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type BuildSystemPromptOptions,
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Input,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";

type Skill = NonNullable<BuildSystemPromptOptions["skills"]>[number];

const FRONTMATTER = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?=\r?\n|$))/;
const DISABLE_KEY = /^([ \t]*disable-model-invocation[ \t]*:[ \t]*)(true|false)([ \t]*(?:#.*)?)$/im;
const USER_SETTINGS_PATH = join(getAgentDir(), "settings.json");
const COMMAND_ARGUMENTS = [
  {
    value: "settings",
    label: "settings",
    description: "Open skill settings",
  },
  {
    value: "config",
    label: "config",
    description: "Alias for settings",
  },
  {
    value: "help",
    label: "help",
    description: "Display command usage",
  },
  {
    value: "list",
    label: "list",
    description: "List enabled or disabled skills",
  },
  {
    value: "edit",
    label: "edit",
    description: "Edit skill model visibility",
  },
] as const;
const USAGE_TEXT =
  "Usage: /skills [list [enabled|disabled]|edit [enabled|disabled]|settings|config [project]|<name> enable|disable|help]";

type Settings = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [];
}

async function readSettings(path: string): Promise<Settings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("settings.json must contain an object");
    return parsed;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeSettings(path: string, settings: Settings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function createBorder(theme: { fg(color: string, text: string): string }) {
  return {
    render: (width: number) => [theme.fg("border", "─".repeat(Math.max(1, width)))],
    invalidate: () => {},
  };
}

function isWritableSkill(skill: Skill): boolean {
  const info = skill.sourceInfo;
  return (
    info.origin === "top-level" &&
    (info.scope === "user" || info.scope === "project") &&
    !skill.filePath.startsWith("<")
  );
}

async function canWrite(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function setModelInvocation(filePath: string, disabled: boolean): Promise<void> {
  const source = await readFile(filePath, "utf8");
  const match = source.match(FRONTMATTER);

  if (!match) {
    if (!disabled) return;
    throw new Error("SKILL.md no contiene frontmatter YAML");
  }

  const [, opening, body, closing] = match;
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  let nextBody = body;

  if (disabled) {
    if (DISABLE_KEY.test(nextBody)) {
      nextBody = nextBody.replace(
        DISABLE_KEY,
        (_line, prefix: string, _value: string, suffix: string) => `${prefix}true${suffix}`,
      );
    } else {
      nextBody = `${nextBody}${newline}disable-model-invocation: true`;
    }
  } else {
    nextBody = nextBody.replace(DISABLE_KEY, "");
    nextBody = nextBody.replace(/\r?\n{3,}/g, newline + newline);
  }

  if (nextBody === body) return;
  await writeFile(
    filePath,
    `${opening}${nextBody}${closing}${source.slice(match[0].length)}`,
    "utf8",
  );
}

function getSkills(ctx: ExtensionCommandContext): Skill[] {
  return [...(ctx.getSystemPromptOptions?.().skills ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

const VALUE_COLUMN_PADDING = "    ";

function settingsPath(ctx: ExtensionCommandContext, scope: "global" | "project"): string {
  return scope === "global" ? USER_SETTINGS_PATH : join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
}

function skillValue(skill: Skill, editable: boolean): string {
  if (!editable) return `${VALUE_COLUMN_PADDING}read-only`;
  return `${VALUE_COLUMN_PADDING}${skill.disableModelInvocation ? "disabled" : "enabled"}`;
}

function formatSkillPaths(paths: string[]): string {
  return paths.length ? `${paths.length} configured` : "none";
}

function parseSkillPaths(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((path) => path.trim())
    .filter(Boolean);
}

function createSkillPathsEditor(paths: string[], done: (value?: string) => void): Component {
  const input = new Input();
  input.setValue(paths.join(", "));
  input.onSubmit = (value) => done(value.trim());
  input.onEscape = () => done(undefined);
  return input;
}

async function showConfig(
  ctx: ExtensionCommandContext,
  scope: "global" | "project" = "global",
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/skills config requires TUI mode", "error");
    return;
  }

  const path = settingsPath(ctx, scope);
  let settings = await readSettings(path);
  let saveQueue = Promise.resolve();
  let changed = false;

  await ctx.ui.custom((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = [
      {
        id: "enableSkillCommands",
        label: "Skill commands",
        description: "Expose /skill:name commands in Pi",
        currentValue: settings.enableSkillCommands === false ? "disabled" : "enabled",
        values: ["enabled", "disabled"],
      },
      {
        id: "skills",
        label: "Skill directories",
        description: "Claude Code, Codex, or other external skill directories",
        currentValue: formatSkillPaths(stringArray(settings.skills)),
        submenu: (_currentValue, close) =>
          createSkillPathsEditor(stringArray(settings.skills), close),
      },
    ];
    const container = new Container();
    container.addChild(createBorder(theme));
    container.addChild(new Text(theme.fg("accent", theme.bold("Skill Settings")), 1, 1));

    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 10),
      getSettingsListTheme(),
      (id, value) => {
        const previous = settings;
        const next = { ...settings };
        if (id === "enableSkillCommands") {
          next.enableSkillCommands = value === "enabled";
        }
        if (id === "skills") {
          next.skills = parseSkillPaths(value);
        }
        changed = true;
        settings = next;
        saveQueue = saveQueue
          .then(() => writeSettings(path, next))
          .catch((error: unknown) => {
            settings = previous;
            const previousValue =
              id === "enableSkillCommands"
                ? previous.enableSkillCommands === false
                  ? "disabled"
                  : "enabled"
                : formatSkillPaths(stringArray(previous.skills));
            list.updateValue(id, previousValue);
            ctx.ui.notify(
              `Failed to save settings: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
            tui.requestRender();
          });
      },
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", `${scope} settings\n${path}`), 1, 1));
    container.addChild(createBorder(theme));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        list.handleInput?.(data);
        tui.requestRender();
      },
    };
  });

  await saveQueue;
  if (changed) await ctx.reload();
}

async function setSkillState(
  ctx: ExtensionCommandContext,
  name: string,
  action: "enable" | "disable",
): Promise<void> {
  const skill = getSkills(ctx).find((candidate) => candidate.name === name);
  if (!skill) {
    ctx.ui.notify(`Unknown skill: ${name}`, "error");
    return;
  }
  if (!isWritableSkill(skill) || !(await canWrite(skill.filePath))) {
    ctx.ui.notify(`${name} is read-only`, "error");
    return;
  }

  const disabled = action === "disable";
  if (skill.disableModelInvocation === disabled) {
    ctx.ui.notify(`${name} is already ${action}d`, "info");
    return;
  }

  await setModelInvocation(skill.filePath, disabled);
  ctx.ui.notify(`${name} ${action}d; reloading skills…`, "info");
  await ctx.reload();
}

async function invokeSkill(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name: string,
  args: string,
): Promise<void> {
  const skill = getSkills(ctx).find((candidate) => candidate.name === name);
  if (!skill) {
    ctx.ui.notify(`Unknown skill: ${name}\n${USAGE_TEXT}`, "warning");
    return;
  }

  try {
    const source = await readFile(skill.filePath, "utf8");
    const match = source.match(FRONTMATTER);
    const body = (match ? match[2] : source).trim();
    const block = [
      `<skill name="${skill.name}" location="${skill.filePath}">`,
      `References are relative to ${skill.baseDir}.`,
      "",
      body,
      "</skill>",
    ].join("\n");
    pi.sendUserMessage(args ? `${block}\n\n${args}` : block);
  } catch (error) {
    ctx.ui.notify(
      `Failed to load ${name}: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function showSkills(
  ctx: ExtensionCommandContext,
  state: "all" | "enabled" | "disabled" = "all",
  allowEdit = false,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/skills requires TUI mode", "error");
    return;
  }

  const skills = getSkills(ctx).filter(
    (skill) =>
      state === "all" ||
      (state === "disabled" ? skill.disableModelInvocation : !skill.disableModelInvocation),
  );
  if (skills.length === 0) {
    ctx.ui.notify(`No ${state === "all" ? "" : `${state} `}skills found.`, "info");
    return;
  }

  const writable = allowEdit
    ? new Map(
        await Promise.all(
          skills.map(
            async (skill) =>
              [skill.name, isWritableSkill(skill) && (await canWrite(skill.filePath))] as const,
          ),
        ),
      )
    : new Map<string, boolean>();
  let changed = false;
  let saveError: Error | undefined;
  let saveQueue = Promise.resolve();
  const title = allowEdit
    ? "Skill Configuration"
    : state === "all"
      ? "Skill List"
      : `${state[0]!.toUpperCase()}${state.slice(1)} Skills`;

  await ctx.ui.custom((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = skills.map((skill) => {
      const editable = allowEdit && writable.get(skill.name) === true;
      return {
        id: skill.name,
        label: skill.name,
        description: !allowEdit
          ? `${skill.filePath} (read-only)`
          : editable
            ? skill.filePath
            : `${skill.filePath} (read-only)`,
        currentValue: allowEdit
          ? skillValue(skill, editable)
          : `${VALUE_COLUMN_PADDING}${skill.disableModelInvocation ? "disabled" : "enabled"}`,
        values: editable
          ? [`${VALUE_COLUMN_PADDING}enabled`, `${VALUE_COLUMN_PADDING}disabled`]
          : undefined,
      };
    });

    const container = new Container();
    container.addChild(createBorder(theme));
    container.addChild({
      render: () => [theme.fg("accent", theme.bold(title)), ""],
      invalidate: () => {},
    });

    const settings = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, value) => {
        const skill = skills.find((candidate) => candidate.name === id);
        if (!allowEdit || !skill || writable.get(id) !== true) return;
        const disabled = value.trim() === "disabled";
        if (skill.disableModelInvocation === disabled) return;
        const previous = skill.disableModelInvocation;
        skill.disableModelInvocation = disabled;
        changed = true;
        saveQueue = saveQueue
          .then(() => setModelInvocation(skill.filePath, disabled))
          .catch((error: unknown) => {
            skill.disableModelInvocation = previous;
            settings.updateValue(id, skillValue(skill, true));
            saveError = error instanceof Error ? error : new Error(String(error));
            ctx.ui.notify(`Failed to update ${id}: ${saveError.message}`, "error");
          });
      },
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(settings);
    container.addChild(createBorder(theme));

    return {
      render: (width: number) =>
        container
          .render(width)
          .map((line) => (allowEdit ? line : line.replace("Enter/Space to change · ", ""))),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        settings.handleInput?.(data);
        tui.requestRender();
      },
    };
  });

  await saveQueue;
  if (saveError || !changed) return;
  ctx.ui.notify("Reloading skills…", "info");
  await ctx.reload();
}

export default function skillsExtension(pi: ExtensionAPI) {
  pi.registerCommand("skills", {
    description: "List, configure, and enable/disable skills",
    getArgumentCompletions: (prefix) => {
      const rawValue = prefix.toLowerCase();
      const value = prefix.trim().toLowerCase();
      const nestedCommand = rawValue.match(/^(list|edit)\s+(.*)$/);
      if (nestedCommand) {
        const command = nestedCommand[1]!;
        const state = nestedCommand[2]!.trim();
        return ["enabled", "disabled"]
          .filter((option) => option.startsWith(state))
          .map((option) => ({
            value: `${command} ${option}`,
            label: `${command} ${option}`,
            description: `${command === "edit" ? "Edit" : "List"} ${option} skills`,
          }));
      }
      if (value.includes(" ")) return null;
      const skillArguments = pi
        .getCommands()
        .filter((command) => command.source === "skill")
        .map((command) => ({
          value: command.name.replace(/^skill:/, ""),
          label: command.name.replace(/^skill:/, ""),
          description: "Invoke this skill or enable/disable it with /skills <name> enable/disable",
        }));
      const seen = new Set<string>();
      const matches = [...COMMAND_ARGUMENTS, ...skillArguments].filter((item) => {
        if (seen.has(item.value)) return false;
        seen.add(item.value);
        return item.value.startsWith(value);
      });
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const first = tokens[0]?.toLowerCase();
      const second = tokens[1]?.toLowerCase();
      if (!first) {
        await showSkills(ctx, "all", true);
        return;
      }
      if (first === "list" || first === "edit") {
        if (tokens.length > 2 || (second && second !== "enabled" && second !== "disabled")) {
          ctx.ui.notify(USAGE_TEXT, "warning");
          return;
        }
        const state = second === "enabled" || second === "disabled" ? second : "all";
        await showSkills(ctx, state, first === "edit");
        return;
      }
      if (first === "config" || first === "settings") {
        if (second && second !== "project") {
          ctx.ui.notify(USAGE_TEXT, "warning");
          return;
        }
        await showConfig(ctx, second === "project" ? "project" : "global");
        return;
      }
      if (first === "help") {
        ctx.ui.notify(
          [
            "/skills — edit all skills (legacy alias)",
            "/skills list [enabled|disabled] — list skills without editing",
            "/skills edit [enabled|disabled] — edit skill model visibility",
            "/skills settings — open global settings",
            "/skills config — alias for settings",
            "/skills config project — open project settings",
            "/skills <name> [args] — invoke a skill",
            "/skills <name> enable|disable — change one skill",
            `Global settings: ${USER_SETTINGS_PATH}`,
          ].join("\n"),
          "info",
        );
        return;
      }
      if (first && (second === "enable" || second === "disable")) {
        await setSkillState(ctx, tokens[0]!, second);
        return;
      }
      await invokeSkill(pi, ctx, tokens[0]!, tokens.slice(1).join(" "));
    },
  });
}
