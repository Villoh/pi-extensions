import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Settings } from "./types.js";

export const DEFAULT_SETTINGS: Settings = {
  accountsDir: "~/.cli-proxy-api",
  refreshMinutes: 5,
  maxVisibleAccounts: 4,
  providers: { claude: true, codex: true, grok: true },
};

type JsonObject = Record<string, unknown>;

export type LoadedSettings = {
  settings: Settings;
  raw: JsonObject;
  path: string;
  warnings: string[];
  writable: boolean;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSettings(value: unknown): {
  settings: Settings;
  raw: JsonObject;
  warnings: string[];
} {
  if (!isObject(value)) throw new Error("settings file must contain a JSON object");
  const warnings: string[] = [];
  const providers = isObject(value.providers) ? value.providers : {};
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);

  if (typeof value.accountsDir === "string" && value.accountsDir.trim()) {
    settings.accountsDir = value.accountsDir.trim();
  } else if (value.accountsDir !== undefined) {
    warnings.push("ignored invalid accountsDir");
  }
  if (
    typeof value.refreshMinutes === "number" &&
    Number.isInteger(value.refreshMinutes) &&
    value.refreshMinutes >= 1
  ) {
    settings.refreshMinutes = value.refreshMinutes;
  } else if (value.refreshMinutes !== undefined) {
    warnings.push("ignored invalid refreshMinutes");
  }
  if (
    typeof value.maxVisibleAccounts === "number" &&
    Number.isInteger(value.maxVisibleAccounts) &&
    value.maxVisibleAccounts > 0
  ) {
    settings.maxVisibleAccounts = value.maxVisibleAccounts;
  } else if (value.maxVisibleAccounts !== undefined) {
    warnings.push("ignored invalid maxVisibleAccounts");
  }
  for (const provider of ["claude", "codex", "grok"] as const) {
    if (typeof providers[provider] === "boolean") {
      settings.providers[provider] = providers[provider];
    } else if (providers[provider] !== undefined) {
      warnings.push(`ignored invalid providers.${provider}`);
    }
  }
  return { settings, raw: value, warnings };
}

async function migrateLegacyFile(settingsPath: string, legacyPath: string): Promise<void> {
  try {
    await stat(settingsPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(legacyPath);
    normalizeSettings(JSON.parse(bytes.toString("utf8")));
  } catch {
    return;
  }

  await mkdir(dirname(settingsPath), { recursive: true });
  try {
    await writeFile(settingsPath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return;
  }
  const current = await readFile(legacyPath).catch(() => undefined);
  if (current?.equals(bytes)) await rm(legacyPath);
}

export async function loadSettings(
  settingsPath: string,
  legacyPath: string,
): Promise<LoadedSettings> {
  await migrateLegacyFile(settingsPath, legacyPath);
  let text: string;
  try {
    text = await readFile(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        settings: structuredClone(DEFAULT_SETTINGS),
        raw: {},
        path: settingsPath,
        warnings: [],
        writable: true,
      };
    }
    throw error;
  }
  try {
    return {
      ...normalizeSettings(JSON.parse(text)),
      path: settingsPath,
      writable: true,
    };
  } catch (error) {
    return {
      settings: structuredClone(DEFAULT_SETTINGS),
      raw: {},
      path: settingsPath,
      warnings: [(error as Error).message],
      writable: false,
    };
  }
}

export async function saveSettings(
  settings: Settings,
  raw: JsonObject,
  settingsPath: string,
): Promise<JsonObject> {
  const next: JsonObject = {
    ...raw,
    ...settings,
    providers: {
      ...(isObject(raw.providers) ? raw.providers : {}),
      ...settings.providers,
    },
  };
  await mkdir(dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, settingsPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return next;
}
