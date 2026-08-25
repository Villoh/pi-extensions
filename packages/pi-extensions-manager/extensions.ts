import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  sliceByColumn,
  visibleWidth,
} from "@earendil-works/pi-tui";

type Scope = "user" | "project";
type SettingsJson = Record<string, unknown>;
type PackageEntry = string | { source?: string; extensions?: unknown[]; [key: string]: unknown };
type SourceInfo = {
  path?: unknown;
  scope?: unknown;
  origin?: unknown;
  source?: unknown;
};

type ManagedExtension = {
  id: string;
  path: string;
  scope: Scope;
  origin: "top-level" | "package";
  source?: string;
  enabled: boolean;
};

type StoredExtension = Omit<ManagedExtension, "enabled">;

const REGISTRY_PATH = join(getAgentDir(), "pi-extension-manager.json");
const EXTENSION_LABEL_WIDTH = 42;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [];
}

function normalizePath(path: string): string {
  return resolve(path).replaceAll("\\", "/");
}

function extensionMarker(extension: ManagedExtension): string {
  return `!${extension.path}`;
}

function truncateFromLeft(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  const ellipsis = "…";
  const suffixWidth = Math.max(0, maxWidth - visibleWidth(ellipsis));
  return `${ellipsis}${sliceByColumn(text, visibleWidth(text) - suffixWidth, suffixWidth)}`;
}

function sourceInfoOf(value: unknown): SourceInfo | undefined {
  if (!isRecord(value) || !isRecord(value.sourceInfo)) return undefined;
  return value.sourceInfo as SourceInfo;
}

function createBorder(theme: { fg(color: string, text: string): string }) {
  return {
    render: (width: number) => [theme.fg("border", "─".repeat(Math.max(1, width)))],
    invalidate: () => {},
  };
}

function collectExtensions(pi: ExtensionAPI): ManagedExtension[] {
  const managerPath = normalizePath(fileURLToPath(import.meta.url));
  const extensions = new Map<string, ManagedExtension>();

  const add = (value: unknown, commandSource?: unknown) => {
    if (commandSource !== undefined && commandSource !== "extension") return;
    const info = sourceInfoOf(value);
    if (!info || typeof info.path !== "string") return;
    if (info.scope !== "user" && info.scope !== "project") return;
    if (info.origin !== "top-level" && info.origin !== "package") return;

    const path = normalizePath(info.path);
    if (path === managerPath) return;
    const source = typeof info.source === "string" ? info.source : undefined;
    const id = path;
    if (extensions.has(id)) return;

    extensions.set(id, {
      id,
      path,
      scope: info.scope,
      origin: info.origin,
      source,
      enabled: true,
    });
  };

  for (const command of pi.getCommands()) {
    add(command, command.source);
  }
  for (const tool of pi.getAllTools()) add(tool);

  return [...extensions.values()].sort((a, b) =>
    (a.origin === "package" ? (a.source ?? basename(a.path)) : basename(a.path)).localeCompare(
      b.origin === "package" ? (b.source ?? basename(b.path)) : basename(b.path),
    ),
  );
}

async function readRegistry(): Promise<ManagedExtension[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is StoredExtension => {
        if (!isRecord(item)) return false;
        return (
          typeof item.id === "string" &&
          typeof item.path === "string" &&
          (item.scope === "user" || item.scope === "project") &&
          (item.origin === "top-level" || item.origin === "package")
        );
      })
      .filter((item) => existsSync(item.path))
      .map((item) => ({ ...item, enabled: true }));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeRegistry(extensions: ManagedExtension[]): Promise<void> {
  const stored: StoredExtension[] = extensions.map(({ enabled: _enabled, ...item }) => item);
  await writeFile(REGISTRY_PATH, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
}

function mergeExtensions(
  current: ManagedExtension[],
  stored: ManagedExtension[],
): ManagedExtension[] {
  const merged = new Map(stored.map((extension) => [extension.id, extension]));
  for (const extension of current) merged.set(extension.id, extension);
  return [...merged.values()].sort((a, b) =>
    (a.origin === "package" ? (a.source ?? basename(a.path)) : basename(a.path)).localeCompare(
      b.origin === "package" ? (b.source ?? basename(b.path)) : basename(b.path),
    ),
  );
}

async function readSettings(path: string): Promise<SettingsJson> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("settings.json must contain an object");
    return parsed;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeSettings(path: string, settings: SettingsJson): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function packageEntries(settings: SettingsJson): PackageEntry[] {
  return Array.isArray(settings.packages) ? (settings.packages as PackageEntry[]) : [];
}

function packageSource(entry: PackageEntry): string | undefined {
  return typeof entry === "string" ? entry : entry.source;
}

function isExtensionDisabled(settings: SettingsJson, extension: ManagedExtension): boolean {
  const marker = extensionMarker(extension);
  if (extension.origin === "package") {
    const entry = packageEntries(settings).find((item) => packageSource(item) === extension.source);
    return isRecord(entry) && stringArray(entry.extensions).some((item) => item === marker);
  }
  return stringArray(settings.extensions).some((item) => item === marker);
}

function setExtensionEnabled(
  settings: SettingsJson,
  extension: ManagedExtension,
  enabled: boolean,
): boolean {
  const marker = extensionMarker(extension);
  if (extension.origin === "package") {
    const packages = packageEntries(settings);
    const index = packages.findIndex((item) => packageSource(item) === extension.source);
    if (index < 0) {
      throw new Error(`Package settings not found: ${extension.source ?? extension.path}`);
    }

    const current = packages[index];
    if (typeof current === "string") {
      if (enabled) return false;
      packages[index] = { source: current, extensions: [marker] };
      settings.packages = packages;
      return true;
    }

    const extensions = stringArray(current.extensions).filter((item) => item !== marker);
    if (!enabled) extensions.push(marker);
    if (
      enabled &&
      !extensions.length &&
      current.source &&
      Object.keys(current).every((key) => key === "source" || key === "extensions")
    ) {
      packages[index] = current.source;
    } else {
      const next = { ...current };
      if (extensions.length) next.extensions = extensions;
      else delete next.extensions;
      packages[index] = next;
    }
    settings.packages = packages;
    return true;
  }

  const extensions = stringArray(settings.extensions).filter((item) => item !== marker);
  if (!enabled) extensions.push(marker);
  settings.extensions = extensions;
  return true;
}

function settingsPath(scope: Scope, cwd: string): string {
  return scope === "user"
    ? resolve(getAgentDir(), "settings.json")
    : resolve(cwd, CONFIG_DIR_NAME, "settings.json");
}

async function showExtensions(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: "all" | "enabled" | "disabled" = "all",
  allowEdit = true,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/extensions requires TUI mode", "error");
    return;
  }

  const allExtensions = mergeExtensions(collectExtensions(pi), await readRegistry());
  if (!allExtensions.length) {
    ctx.ui.notify("No user or project extensions with tools or commands found.", "info");
    return;
  }

  const settings = new Map<Scope, SettingsJson>();
  for (const scope of ["user", "project"] as const) {
    if (allExtensions.some((extension) => extension.scope === scope)) {
      settings.set(scope, await readSettings(settingsPath(scope, ctx.cwd)));
    }
  }
  for (const extension of allExtensions) {
    extension.enabled = !isExtensionDisabled(settings.get(extension.scope) ?? {}, extension);
  }
  await writeRegistry(allExtensions);

  const extensions = allExtensions.filter(
    (extension) =>
      state === "all" || (state === "enabled" ? extension.enabled : !extension.enabled),
  );
  if (!extensions.length) {
    ctx.ui.notify(`No ${state} extensions found.`, "info");
    return;
  }
  const title = allowEdit
    ? "Extension Configuration"
    : state === "all"
      ? "Extension List"
      : `${state[0]!.toUpperCase()}${state.slice(1)} Extensions`;

  let saveQueue = Promise.resolve();
  let saveError: Error | undefined;
  let changed = false;

  await ctx.ui.custom((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = extensions.map((extension) => {
      const name =
        extension.origin === "package"
          ? (extension.source ?? basename(extension.path))
          : basename(extension.path);
      return {
        id: extension.id,
        label: truncateFromLeft(name, EXTENSION_LABEL_WIDTH).padEnd(EXTENSION_LABEL_WIDTH),
        description: extension.path,
        currentValue: extension.enabled ? "enabled" : "disabled",
        values: allowEdit ? ["enabled", "disabled"] : undefined,
      };
    });
    const container = new Container();
    container.addChild(createBorder(theme));
    container.addChild({
      render: () => [theme.fg("accent", theme.bold(title)), ""],
      invalidate: () => {},
    });

    let list!: SettingsList;
    list = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, value) => {
        if (!allowEdit) return;
        const extension = extensions.find((item) => item.id === id);
        if (!extension) return;
        const previous = extension.enabled;
        const enabled = value === "enabled";
        if (previous === enabled) return;
        extension.enabled = enabled;
        changed = true;
        saveQueue = saveQueue
          .then(async () => {
            const target = settings.get(extension.scope);
            if (!target) throw new Error("Extension settings are not loaded");
            setExtensionEnabled(target, extension, enabled);
            await writeSettings(settingsPath(extension.scope, ctx.cwd), target);
          })
          .catch((error: unknown) => {
            extension.enabled = previous;
            list.updateValue(id, previous ? "enabled" : "disabled");
            saveError = error instanceof Error ? error : new Error(String(error));
            ctx.ui.notify(`Failed to save extension settings: ${saveError.message}`, "error");
          });
      },
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(list);
    container.addChild(createBorder(theme));

    return {
      render: (width: number) =>
        container
          .render(width)
          .map((line) => (allowEdit ? line : line.replace("Enter/Space to change · ", ""))),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        list.handleInput?.(data);
        tui.requestRender();
      },
    };
  });

  await saveQueue;
  if (saveError || !changed) return;
  ctx.ui.notify("Reloading extensions…", "info");
  await ctx.reload();
}

const COMMAND_ARGUMENTS = [
  {
    value: "list",
    label: "list",
    description: "List extensions without editing",
  },
];

export default function extensionsExtension(pi: ExtensionAPI) {
  pi.registerCommand("extensions", {
    description: "List, view, and enable/disable extensions",
    getArgumentCompletions: (prefix) => {
      const rawValue = prefix.toLowerCase();
      const value = prefix.trim().toLowerCase();
      const nestedList = rawValue.match(/^list\s+(.*)$/);
      if (nestedList) {
        const state = nestedList[1]!.trim();
        return ["enabled", "disabled"]
          .filter((option) => option.startsWith(state))
          .map((option) => ({
            value: `list ${option}`,
            label: `list ${option}`,
            description: `List ${option} extensions`,
          }));
      }
      const matches = COMMAND_ARGUMENTS.filter((item) => item.value.startsWith(value));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const first = tokens[0]?.toLowerCase();
      const second = tokens[1]?.toLowerCase();
      if (!first) {
        await showExtensions(pi, ctx, "all", true);
        return;
      }
      if (first === "list") {
        if (tokens.length > 2 || (second && second !== "enabled" && second !== "disabled")) {
          ctx.ui.notify("Usage: /extensions list [enabled|disabled]", "warning");
          return;
        }
        const state = second === "enabled" || second === "disabled" ? second : "all";
        await showExtensions(pi, ctx, state, false);
        return;
      }
      await showExtensions(pi, ctx, "all", true);
    },
  });
}
