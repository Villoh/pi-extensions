import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseClaude, parseCodex, parseGrok, toNumber } from "./parsers.js";
import type { AccountSummary, AccountUsage, Config, ProviderName } from "./types.js";

type AuthFile = {
  type?: string;
  email?: string;
  access_token?: string;
  account_id?: string;
  disabled?: boolean;
};

const PROVIDERS = new Set<ProviderName>(["claude", "codex", "grok"]);
const USAGE_URLS = {
  claude: "https://api.anthropic.com/api/oauth/usage",
  codex: "https://chatgpt.com/backend-api/wham/usage",
  grok: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
} as const;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}

function providerName(type?: string): ProviderName | undefined {
  const provider = type === "xai" ? "grok" : type;
  return PROVIDERS.has(provider as ProviderName) ? (provider as ProviderName) : undefined;
}

async function request(
  url: string,
  token: string,
  headers: Record<string, string> = {},
): Promise<{ body: unknown; headers: Headers }> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "pi-cliproxy-usage",
      ...headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { body: await response.json(), headers: response.headers };
}

async function fetchUsage(
  provider: ProviderName,
  auth: AuthFile,
  file: string,
  hideEmails: boolean,
): Promise<AccountUsage> {
  const label = accountLabel(auth, file, hideEmails);
  try {
    if (!auth.access_token) throw new Error("missing access_token");
    if (provider === "claude") {
      const { body } = await request(USAGE_URLS.claude, auth.access_token, {
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      });
      return { provider, label, ...parseClaude(body) };
    }
    if (provider === "codex") {
      const headers: Record<string, string> = {};
      if (auth.account_id) headers["ChatGPT-Account-Id"] = auth.account_id;
      const response = await request(USAGE_URLS.codex, auth.access_token, headers);
      const parsed = parseCodex(response.body);
      if (!parsed.session) {
        const used = toNumber(response.headers.get("x-codex-primary-used-percent"));
        if (used !== undefined) parsed.session = { used };
      }
      return { provider, label, ...parsed };
    }
    const { body } = await request(USAGE_URLS.grok, auth.access_token, {
      "X-XAI-Token-Auth": "xai-grok-cli",
    });
    return { provider, label, ...parseGrok(body) };
  } catch (error) {
    return {
      provider,
      label,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadAuth(
  dir: string,
  name: string,
): Promise<{ auth: AuthFile; provider: ProviderName } | undefined> {
  try {
    const auth = JSON.parse(await readFile(join(dir, name), "utf8")) as AuthFile;
    const provider = providerName(auth.type);
    if (!provider || auth.disabled) return undefined;
    return { auth, provider };
  } catch {
    return undefined;
  }
}

function maskPart(part: string): string {
  return part ? `${part[0]}${"*".repeat(Math.max(part.length - 1, 3))}` : part;
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${maskPart(email.slice(0, at))}@***${tld}`;
}

function accountLabel(auth: AuthFile, name: string, hideEmails: boolean): string {
  const label = auth.email || basename(name, ".json").replace(/^(claude|codex|xai)-/, "");
  return hideEmails && auth.email ? maskEmail(label) : label;
}

async function readAccount(
  dir: string,
  name: string,
  config: Config,
): Promise<AccountUsage | undefined> {
  const loaded = await loadAuth(dir, name);
  if (!loaded) return undefined;
  const { auth, provider } = loaded;
  if (!config.providers[provider] || config.accounts[name] === false) return undefined;
  return fetchUsage(provider, auth, join(dir, name), config.hideEmails);
}

export async function readAccounts(config: Config): Promise<AccountUsage[]> {
  const dir = expandHome(config.accountsDir);
  try {
    const names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".json"));
    const accounts = await Promise.all(names.map((name) => readAccount(dir, name, config)));
    return accounts.filter(Boolean) as AccountUsage[];
  } catch {
    return [];
  }
}

/** Lists accounts available under accountsDir, ignoring the enabled/disabled toggles. */
export async function discoverAccounts(
  config: Pick<Config, "accountsDir" | "hideEmails">,
): Promise<AccountSummary[]> {
  const dir = expandHome(config.accountsDir);
  try {
    const names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".json"));
    const accounts = await Promise.all(
      names.map(async (name) => {
        const loaded = await loadAuth(dir, name);
        if (!loaded) return undefined;
        return {
          id: name,
          label: accountLabel(loaded.auth, name, config.hideEmails),
          provider: loaded.provider,
        };
      }),
    );
    return accounts.filter(Boolean) as AccountSummary[];
  } catch {
    return [];
  }
}
