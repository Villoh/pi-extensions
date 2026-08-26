import {
  type AuthFileEntry,
  apiCall,
  listAuthFiles,
  listDeepSeekAccounts,
  resolveManagementRoot,
} from "./management-client.js";
import { parseClaude, parseCodex, parseDeepSeek, parseGrok } from "./parsers.js";
import type { AccountSummary, AccountUsage, ProviderName, Settings } from "./types.js";

function maskPart(part: string): string {
  return part ? `${part[0]}${"*".repeat(Math.max(part.length - 1, 3))}` : part;
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return `${maskPart(email.slice(0, at))}@***${dot > 0 ? domain.slice(dot) : ""}`;
}

function displayLabel(label: string, hideEmails: boolean): string {
  return hideEmails && label.includes("@") ? maskEmail(label) : label;
}

const PROVIDER_REQUEST: Record<
  ProviderName,
  { url: string; header(entry: AuthFileEntry): Record<string, string> }
> = {
  claude: {
    url: "https://api.anthropic.com/api/oauth/usage",
    header: () => ({
      Authorization: "Bearer $TOKEN$",
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
    }),
  },
  codex: {
    url: "https://chatgpt.com/backend-api/wham/usage",
    header: (entry) => ({
      Authorization: "Bearer $TOKEN$",
      "User-Agent": "pi-cliproxy-usage",
      ...(entry.chatgptAccountId ? { "ChatGPT-Account-Id": entry.chatgptAccountId } : {}),
    }),
  },
  grok: {
    url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    header: () => ({ Authorization: "Bearer $TOKEN$", "X-XAI-Token-Auth": "xai-grok-cli" }),
  },
  deepseek: {
    url: "https://api.deepseek.com/user/balance",
    header: () => ({ Authorization: "Bearer $TOKEN$" }),
  },
};

const PARSE: Record<ProviderName, (body: unknown) => Partial<AccountUsage>> = {
  claude: parseClaude,
  codex: parseCodex,
  grok: parseGrok,
  deepseek: parseDeepSeek,
};

async function fetchOne(
  root: string,
  key: string,
  provider: ProviderName,
  entry: AuthFileEntry,
  hideEmails: boolean,
): Promise<AccountUsage> {
  const request = PROVIDER_REQUEST[provider];
  try {
    const result = await apiCall(root, key, {
      authIndex: entry.authIndex,
      method: "GET",
      url: request.url,
      header: request.header(entry),
    });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`HTTP ${result.statusCode}`);
    }
    return {
      id: entry.authIndex,
      provider,
      label: displayLabel(entry.label, hideEmails),
      ...PARSE[provider](JSON.parse(result.body)),
    };
  } catch (error) {
    return {
      id: entry.authIndex,
      provider,
      label: displayLabel(entry.label, hideEmails),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type ReadResult = { items: AccountUsage[] } | { error: string };

export async function discoverAccounts(settings: Settings): Promise<AccountSummary[]> {
  if (!settings.managementKey) return [];
  const resolved = await resolveManagementRoot(settings);
  if ("error" in resolved) return [];
  try {
    const grouped = await listAuthFiles(resolved.root, settings.managementKey);
    const accounts: AccountSummary[] = [];
    for (const provider of ["claude", "codex", "grok"] as const) {
      for (const entry of grouped.get(provider) ?? []) {
        accounts.push({
          id: entry.authIndex,
          provider,
          label: displayLabel(entry.label, settings.hideEmails),
        });
      }
    }
    for (const entry of await listDeepSeekAccounts(resolved.root, settings.managementKey)) {
      accounts.push({
        id: entry.authIndex,
        provider: "deepseek",
        label: displayLabel(entry.label, settings.hideEmails),
      });
    }
    return accounts;
  } catch {
    return [];
  }
}

/**
 * Fetches quota/balance for every enabled account of a single provider — the provider matching
 * the active Pi model, per the caller. These requests go through CLIProxyAPI's Management API
 * and never consume LLM input/output tokens.
 */
export async function readProviderAccounts(
  settings: Settings,
  provider: ProviderName,
): Promise<ReadResult> {
  if (!settings.providers[provider]) return { items: [] };
  if (!settings.managementKey) {
    return { error: "Management password not configured. Run /cliproxy-usage setup." };
  }
  const resolved = await resolveManagementRoot(settings);
  if ("error" in resolved) return resolved;
  try {
    const entries =
      provider === "deepseek"
        ? await listDeepSeekAccounts(resolved.root, settings.managementKey)
        : ((await listAuthFiles(resolved.root, settings.managementKey)).get(provider) ?? []);
    const items = await Promise.all(
      entries
        .filter(
          (entry) =>
            settings.selectionMode !== "manual" || settings.accounts[entry.authIndex] !== false,
        )
        .map((entry) =>
          fetchOne(
            resolved.root,
            settings.managementKey as string,
            provider,
            entry,
            settings.hideEmails,
          ),
        ),
    );
    return { items };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
