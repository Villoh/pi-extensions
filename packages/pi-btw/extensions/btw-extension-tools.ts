import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  type ResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Opt-in extension tools for BTW child sessions, configured in `btw.json`
// (global: <agentDir>/btw.json, project: <cwd>/.pi/btw.json). Deliberately a
// different file from `pi-btw.json`, which holds model/thinking/tools defaults.

/** Resolve local paths relative to the config that owns them, not process.cwd(). */
function resolveSource(source: string, configPath: string): string {
  if (source.startsWith("npm:") || source.startsWith("git:")) return source;
  if (source.startsWith("~/")) return join(homedir(), source.slice(2));
  return resolve(dirname(configPath), source);
}

async function readExtensionSources(path: string): Promise<string[] | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Cannot read BTW config ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error(`Invalid BTW config ${path}: expected JSON.`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid BTW config ${path}: expected an object.`);
  }
  if ("workspace" in config) {
    // Failing loudly: silently running locally would hide a remote-workspace expectation.
    throw new Error(
      `Invalid BTW config ${path}: "workspace" is not supported by @villoh/pi-btw (no SSH workspaces).`,
    );
  }
  if (Object.keys(config).some((field) => field !== "extensions")) {
    throw new Error(`Invalid BTW config ${path}: only the "extensions" key is supported.`);
  }
  const extensions = (config as { extensions?: unknown }).extensions;
  if (extensions === undefined) return undefined;
  if (
    !Array.isArray(extensions) ||
    extensions.some((source) => typeof source !== "string" || !source.trim())
  ) {
    throw new Error(
      `Invalid BTW config ${path}: "extensions" must be an array of nonempty source strings.`,
    );
  }
  return [...new Set(extensions.map((source: string) => resolveSource(source.trim(), path)))];
}

/** Project lists replace global lists, including an explicit empty list. */
export async function readBtwExtensionSources(options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
}): Promise<string[]> {
  const globalSources = await readExtensionSources(join(options.agentDir, "btw.json"));
  const projectSources = options.projectTrusted
    ? await readExtensionSources(join(options.cwd, ".pi", "btw.json"))
    : undefined;
  return projectSources ?? globalSources ?? [];
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Resolve the allowlist before running any extension factories. Remote packages
 * have a BTW-owned install root so Pi's factory cache cannot reuse the parent's
 * module globals. Local sources already loaded by the parent are rejected.
 */
export async function loadBtwExtensionResources(options: {
  cwd: string;
  agentDir: string;
  sources: string[];
  parentExtensionPaths: string[];
}): Promise<ResourceLoader> {
  const agentDir = join(options.agentDir, "btw");
  const settingsManager = SettingsManager.inMemory();
  const packages = new DefaultPackageManager({ cwd: options.cwd, agentDir, settingsManager });
  const selectedPaths = new Set<string>();
  for (const source of options.sources) {
    const resolved = await packages.resolveExtensionSources([source], { temporary: true });
    const paths = resolved.extensions
      .filter((resource) => resource.enabled)
      .map((resource) => resource.path);
    if (paths.length === 0)
      throw new Error(`BTW source ${source} did not resolve to any extensions.`);
    for (const path of paths) selectedPaths.add(path);
  }
  const paths = [...selectedPaths];
  const parentPaths = new Set(await Promise.all(options.parentExtensionPaths.map(canonicalPath)));
  for (const path of paths) {
    if (parentPaths.has(await canonicalPath(path))) {
      throw new Error(
        `BTW cannot reload the parent's extension ${path}: Pi can share its module state. Use an npm: or git: source for a separate BTW install.`,
      );
    }
  }
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: paths,
  });
  await loader.reload();
  return loader;
}
