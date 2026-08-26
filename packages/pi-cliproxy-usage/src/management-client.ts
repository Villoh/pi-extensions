import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ProviderName, Settings } from "./types.js";

const AUTH_FILES_PATH = "/v0/management/auth-files";
const OPENAI_COMPAT_PATH = "/v0/management/openai-compatibility";
const API_CALL_PATH = "/v0/management/api-call";

export class ManagementError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Root form or a form ending in /v1 are both accepted; reverse-proxy path prefixes are preserved. */
export function normalizeProviderBaseUrl(raw: string): string {
  const trimmed = stripTrailingSlash(raw.trim());
  return trimmed.endsWith("/v1") ? stripTrailingSlash(trimmed.slice(0, -3)) : trimmed;
}

/** A trailing /v0/management is accepted and normalized away. */
export function normalizeManagementUrl(raw: string): string {
  const trimmed = stripTrailingSlash(raw.trim());
  return trimmed.endsWith("/v0/management")
    ? stripTrailingSlash(trimmed.slice(0, -"/v0/management".length))
    : trimmed;
}

export type ResolvedRoot = { root: string } | { error: string };

export async function resolveManagementRoot(
  settings: Pick<Settings, "managementUrl">,
): Promise<ResolvedRoot> {
  if (settings.managementUrl.trim()) {
    return { root: normalizeManagementUrl(settings.managementUrl) };
  }
  try {
    // Resolved per call, not cached at module load, so PI_CODING_AGENT_DIR overrides (and tests) apply.
    const path = join(getAgentDir(), "cliproxyapi.json");
    const raw = JSON.parse(await readFile(path, "utf8")) as { baseUrl?: unknown };
    if (typeof raw.baseUrl === "string" && raw.baseUrl.trim()) {
      return { root: normalizeProviderBaseUrl(raw.baseUrl) };
    }
  } catch {
    // Fall through to the "not configured" error below.
  }
  return {
    error:
      "No CLIProxyAPI URL found. Configure a CLIProxyAPI-backed model, or set a management URL override via /cliproxy-usage settings.",
  };
}

async function managementFetch(
  root: string,
  key: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`${root}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new ManagementError(`Management API HTTP ${response.status}`, response.status);
  return response;
}

export async function validateManagementKey(
  root: string,
  key: string,
): Promise<{ ok: true } | { ok: false; status?: number; message: string }> {
  try {
    await managementFetch(root, key, AUTH_FILES_PATH);
    return { ok: true };
  } catch (error) {
    if (error instanceof ManagementError)
      return { ok: false, status: error.status, message: error.message };
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export type AuthFileEntry = {
  authIndex: string;
  provider: ProviderName;
  label: string;
  chatgptAccountId?: string;
};

// CLIProxyAPI auth-file "type"/"provider" values map onto our provider names; "xai" is Grok.
const AUTH_FILE_PROVIDER: Record<string, ProviderName> = {
  claude: "claude",
  codex: "codex",
  xai: "grok",
};

/** Lists OAuth accounts via GET /v0/management/auth-files, grouped by provider. Skips disabled entries. */
export async function listAuthFiles(
  root: string,
  key: string,
): Promise<Map<ProviderName, AuthFileEntry[]>> {
  const response = await managementFetch(root, key, AUTH_FILES_PATH);
  const body = (await response.json()) as { files?: unknown[] };
  const byProvider = new Map<ProviderName, AuthFileEntry[]>();
  for (const raw of body.files ?? []) {
    const file = raw as Record<string, unknown>;
    if (file.disabled === true) continue;
    const provider = AUTH_FILE_PROVIDER[String(file.provider ?? file.type ?? "").toLowerCase()];
    const authIndex = String(file.auth_index ?? "").trim();
    if (!provider || !authIndex) continue;
    const label = String(file.email ?? file.label ?? file.name ?? authIndex);
    const idToken = file.id_token as Record<string, unknown> | undefined;
    const chatgptAccountId =
      typeof idToken?.chatgpt_account_id === "string" ? idToken.chatgpt_account_id : undefined;
    const list = byProvider.get(provider) ?? [];
    list.push(
      chatgptAccountId
        ? { authIndex, provider, label, chatgptAccountId }
        : { authIndex, provider, label },
    );
    byProvider.set(provider, list);
  }
  return byProvider;
}

/**
 * DeepSeek accounts aren't OAuth auth files — they're openai-compatibility API-key entries.
 * Discovered by requiring the exact api.deepseek.com hostname; only auth_index is retained,
 * the api-key field itself is never read.
 */
export async function listDeepSeekAccounts(root: string, key: string): Promise<AuthFileEntry[]> {
  const response = await managementFetch(root, key, OPENAI_COMPAT_PATH);
  const body = await response.json();
  const record = body as Record<string, unknown> | unknown[];
  const entries: unknown[] = Array.isArray(record)
    ? record
    : (((record as Record<string, unknown>)?.["openai-compatibility"] as unknown[] | undefined) ??
      ((record as Record<string, unknown>)?.data as unknown[] | undefined) ??
      []);
  const accounts: AuthFileEntry[] = [];
  for (const raw of entries) {
    const entry = raw as Record<string, unknown>;
    if (entry.disabled === true) continue;
    let hostname: string;
    try {
      hostname = new URL(String(entry["base-url"] ?? entry.baseUrl ?? "")).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (hostname !== "api.deepseek.com") continue;
    const label = String(entry.name ?? "deepseek");
    const keyEntries = (entry["api-key-entries"] ?? entry.apiKeyEntries ?? []) as unknown[];
    for (const rawKeyEntry of keyEntries) {
      const keyEntry = rawKeyEntry as Record<string, unknown>;
      const authIndex = String(keyEntry["auth-index"] ?? keyEntry.authIndex ?? "").trim();
      if (!authIndex) continue;
      accounts.push({ authIndex, provider: "deepseek", label });
    }
  }
  return accounts;
}

export type ApiCallResult = { statusCode: number; body: string };

/** Proxies a request through POST /v0/management/api-call. "$TOKEN$" in header values is substituted server-side. */
export async function apiCall(
  root: string,
  key: string,
  params: { authIndex: string; method: string; url: string; header?: Record<string, string> },
): Promise<ApiCallResult> {
  const response = await managementFetch(root, key, API_CALL_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_index: params.authIndex,
      method: params.method,
      url: params.url,
      header: params.header,
    }),
  });
  const parsed = (await response.json()) as { status_code: number; body?: string };
  return { statusCode: parsed.status_code, body: parsed.body ?? "" };
}
