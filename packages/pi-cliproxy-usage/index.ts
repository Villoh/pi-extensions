import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveManagementRoot } from "./src/management-client.js";
import { loadSettings } from "./src/settings.js";
import { showSettings } from "./src/settings-ui.js";
import { runLogout, runSetup } from "./src/setup-ui.js";
import type { AccountUsage, ProviderName, Settings } from "./src/types.js";
import {
  clearUsage,
  createUsageReport,
  renderReport,
  renderUsage,
  type UsageReport,
} from "./src/ui.js";
import { readProviderAccounts } from "./src/usage.js";

const COMMAND_ARGUMENTS = [
  { value: "setup", label: "setup", description: "Enter and validate the Management API password" },
  { value: "login", label: "login", description: "Alias for setup" },
  { value: "logout", label: "logout", description: "Remove the saved Management API password" },
  { value: "settings", label: "settings", description: "Edit CLIProxyAPI usage settings" },
  { value: "refresh", label: "refresh", description: "Refresh and display current account usage" },
  { value: "status", label: "status", description: "Display effective settings and source" },
  { value: "help", label: "help", description: "Display command usage" },
] as const;
const USAGE_TEXT = "Usage: /cliproxy-usage [setup|login|logout|settings|refresh|status|help]";
const SETTINGS_PATH = join(getAgentDir(), "pi-cliproxy-usage.json");
const LEGACY_SETTINGS_PATH = join(getAgentDir(), "extensions", "pi-cliproxy-usage", "config.json");

const PROVIDER_HINTS: Record<ProviderName, RegExp> = {
  deepseek: /deepseek/,
  claude: /claude|anthropic/,
  codex: /codex|gpt|openai/,
  grok: /grok|xai/,
};

/**
 * Maps the active Pi model to one of our provider names by matching its provider id / model id
 * against known substrings. Works for both native provider ids ("anthropic", "xai", ...) and a
 * custom CLIProxyAPI provider whose model ids describe the underlying account (e.g. "claude-...").
 * ponytail: string-match heuristic, not an exact contract with the companion CLIProxyAPI
 * provider extension; replace with an explicit allowlist if it misidentifies models.
 */
function guessProviderName(
  model: { provider?: string; id?: string } | undefined,
): ProviderName | undefined {
  const haystack = `${model?.provider ?? ""} ${model?.id ?? ""}`.toLowerCase();
  return (Object.keys(PROVIDER_HINTS) as ProviderName[]).find((name) =>
    PROVIDER_HINTS[name].test(haystack),
  );
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshing: Promise<void> | undefined;
  const cache = new Map<ProviderName, { items: AccountUsage[]; fetchedAt: number }>();

  pi.registerEntryRenderer<UsageReport>("cliproxy-usage", (entry, _options, theme) =>
    entry.data ? new Text(renderReport(entry.data, theme), 1, 0) : undefined,
  );

  const showReport = (
    ctx: ExtensionContext,
    report: UsageReport,
    level: "info" | "warning" = "info",
  ) => {
    if (ctx.mode === "tui") pi.appendEntry("cliproxy-usage", report);
    else ctx.ui.notify(renderReport(report, ctx.ui.theme), level);
  };

  const refresh = (ctx: ExtensionContext, opts: { notify?: boolean; force?: boolean } = {}) =>
    (refreshing ??= (async () => {
      const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
      if (loaded.warnings.length && ctx.hasUI) ctx.ui.notify(loaded.warnings.join("; "), "warning");

      const activeProvider = guessProviderName(ctx.model);
      const providers =
        loaded.settings.selectionMode === "manual"
          ? (Object.keys(loaded.settings.providers) as ProviderName[]).filter(
              (name) => loaded.settings.providers[name],
            )
          : activeProvider
            ? [activeProvider]
            : [];
      if (!providers.length) {
        clearUsage(ctx);
        if (opts.notify && loaded.settings.selectionMode === "auto")
          ctx.ui.notify("No CLIProxyAPI provider matches the current model.", "warning");
        return;
      }

      const allItems: AccountUsage[] = [];
      for (const provider of providers) {
        const cached = cache.get(provider);
        const isFresh =
          cached && Date.now() - cached.fetchedAt < loaded.settings.refreshMinutes * 60_000;
        if (isFresh && !opts.force) {
          allItems.push(...cached.items);
          continue;
        }
        const result = await readProviderAccounts(loaded.settings, provider);
        if ("error" in result) {
          clearUsage(ctx);
          if (opts.notify) ctx.ui.notify(result.error, "warning");
          return;
        }
        cache.set(provider, { items: result.items, fetchedAt: Date.now() });
        allItems.push(...result.items);
      }
      renderUsage(ctx, allItems, loaded.settings.maxVisibleAccounts, loaded.settings.hideEmails);
      if (opts.notify)
        showReport(
          ctx,
          createUsageReport(allItems, loaded.settings.hideEmails),
          allItems.some((item) => item.error) ? "warning" : "info",
        );
    })().finally(() => {
      refreshing = undefined;
    }));

  const scheduleRefresh = (ctx: ExtensionContext, minutes: number) => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => void refresh(ctx, { force: true }), minutes * 60_000);
    timer.unref?.();
  };

  const applySettings = async (ctx: ExtensionContext, settings: Settings, changedId: string) => {
    scheduleRefresh(ctx, settings.refreshMinutes);
    // Only refetch when something that affects the fetched data changed.
    // Interval/display-only changes (refreshMinutes, maxVisibleAccounts) must
    // not trigger a request, or every settings tweak burns an API call and
    // risks rate limiting.
    if (changedId === "refreshMinutes" || changedId === "maxVisibleAccounts") return;
    await refresh(ctx, { force: true });
  };

  const showStatus = async (ctx: ExtensionCommandContext) => {
    const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
    const resolved = await resolveManagementRoot(loaded.settings);
    const provider = guessProviderName(ctx.model);
    const cached = provider ? cache.get(provider) : undefined;
    const providers = Object.entries(loaded.settings.providers)
      .filter(([, enabled]) => enabled)
      .map(([name]) =>
        name === "deepseek" ? "DeepSeek" : `${name[0].toUpperCase()}${name.slice(1)}`,
      )
      .join(", ");
    const unavailable = "error" in resolved;
    showReport(
      ctx,
      {
        title: "CLIProxyAPI Status",
        sections: [
          {
            title: "Connection",
            rows: [
              {
                label: "Management API",
                value: unavailable ? `Unavailable — ${resolved.error}` : resolved.root,
                ...(unavailable ? { tone: "warning" as const } : {}),
              },
              ...(!unavailable
                ? [{ label: "Dashboard", value: `${resolved.root}/management.html` }]
                : []),
            ],
          },
          {
            title: "Configuration",
            rows: [
              {
                label: "Password",
                value: loaded.settings.managementKey ? "configured" : "not set",
              },
              { label: "Mode", value: loaded.settings.selectionMode },
              { label: "Providers", value: providers || "none" },
              {
                label: "Refresh",
                value: `every ${loaded.settings.refreshMinutes} min · ${loaded.settings.maxVisibleAccounts} visible`,
              },
              {
                label: "Accounts",
                value: `${Object.values(loaded.settings.accounts).filter((enabled) => !enabled).length} disabled · emails ${loaded.settings.hideEmails ? "hidden" : "shown"}`,
              },
              { label: "Settings file", value: loaded.path },
            ],
          },
          {
            title: "Cache",
            rows: [
              { label: "Model provider", value: provider ?? "unmatched" },
              {
                label: "Last refresh",
                value: cached ? new Date(cached.fetchedAt).toLocaleTimeString() : "never",
              },
            ],
          },
          ...(loaded.warnings.length
            ? [
                {
                  title: "Warnings",
                  rows: loaded.warnings.map((value) => ({
                    label: "Warning",
                    value,
                    tone: "warning" as const,
                  })),
                },
              ]
            : []),
        ],
        footer: "/cliproxy-usage settings",
      },
      loaded.warnings.length ? "warning" : "info",
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
    if (loaded.warnings.length && ctx.hasUI) ctx.ui.notify(loaded.warnings.join("; "), "warning");
    await refresh(ctx);
    scheduleRefresh(ctx, loaded.settings.refreshMinutes);
  });

  pi.on("model_select", async (_event, ctx) => {
    await refresh(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    clearUsage(ctx);
  });

  pi.registerCommand("cliproxy-usage", {
    description: "Configure CLIProxyAPI Management API usage monitoring",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trim().toLowerCase();
      const matches = COMMAND_ARGUMENTS.filter((item) => item.value.startsWith(value));
      return matches.length ? [...matches] : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!action) return refresh(ctx, { notify: true, force: true });
      if (action === "setup" || action === "login")
        return runSetup(ctx, SETTINGS_PATH, LEGACY_SETTINGS_PATH);
      if (action === "logout") {
        cache.clear();
        if (await runLogout(ctx, SETTINGS_PATH, LEGACY_SETTINGS_PATH)) clearUsage(ctx);
        return;
      }
      if (action === "settings") {
        return showSettings(ctx, SETTINGS_PATH, LEGACY_SETTINGS_PATH, (settings, changedId) =>
          applySettings(ctx, settings, changedId),
        );
      }
      if (action === "refresh") return refresh(ctx, { notify: true, force: true });
      if (action === "status") return showStatus(ctx);
      if (action === "help") {
        ctx.ui.notify(
          [
            "/cliproxy-usage — refresh and show quota for the current model",
            "/cliproxy-usage setup — enter, validate, and save the Management API password",
            "/cliproxy-usage login — alias for setup",
            "/cliproxy-usage logout — remove the saved Management API password",
            "/cliproxy-usage settings — edit the management URL override, refresh interval, and provider toggles",
            "/cliproxy-usage status — show effective URLs, settings warnings, and last refresh time",
            `Manual settings: ${SETTINGS_PATH}`,
          ].join("\n"),
          "info",
        );
        return;
      }
      ctx.ui.notify(USAGE_TEXT, "warning");
    },
  });
}
