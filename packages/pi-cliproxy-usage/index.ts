import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { loadSettings } from "./src/settings.js";
import { showSettings } from "./src/settings-ui.js";
import type { Settings } from "./src/types.js";
import { clearUsage, formatDetails, renderUsage } from "./src/ui.js";
import { readAccounts } from "./src/usage.js";

const COMMAND_ARGUMENTS = [
  {
    value: "settings",
    label: "settings",
    description: "Edit CLIProxyAPI usage settings",
  },
  {
    value: "config",
    label: "config",
    description: "Alias for the settings command",
  },
  {
    value: "refresh",
    label: "refresh",
    description: "Fetch and display current account usage",
  },
  {
    value: "status",
    label: "status",
    description: "Display effective settings and source",
  },
  {
    value: "help",
    label: "help",
    description: "Display command usage",
  },
] as const;
const USAGE_TEXT = "Usage: /cliproxy-usage [settings|config|refresh|status|help]";
const SETTINGS_PATH = join(getAgentDir(), "pi-cliproxy-usage.json");
const LEGACY_SETTINGS_PATH = join(getAgentDir(), "extensions", "pi-cliproxy-usage", "config.json");

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshing: Promise<void> | undefined;

  const refresh = (ctx: ExtensionContext, notify = false) =>
    (refreshing ??= (async () => {
      const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
      if (loaded.warnings.length && ctx.hasUI) {
        ctx.ui.notify(loaded.warnings.join("; "), "warning");
      }
      const items = await readAccounts(loaded.settings);
      renderUsage(ctx, items, loaded.settings.maxVisibleAccounts);
      if (notify) {
        ctx.ui.notify(formatDetails(items), items.some((item) => item.error) ? "warning" : "info");
      }
    })().finally(() => {
      refreshing = undefined;
    }));

  const scheduleRefresh = (ctx: ExtensionContext, minutes: number) => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => void refresh(ctx), minutes * 60_000);
    timer.unref?.();
  };

  const applySettings = async (ctx: ExtensionContext, settings: Settings, changedId: string) => {
    scheduleRefresh(ctx, settings.refreshMinutes);
    // Only refetch when something that affects the fetched data changed.
    // Interval/display-only changes (refreshMinutes, maxVisibleAccounts) must
    // not trigger a request, or every settings tweak burns an API call and
    // risks rate limiting.
    if (changedId === "refreshMinutes" || changedId === "maxVisibleAccounts") {
      return;
    }
    await refresh(ctx);
  };

  const showStatus = async (ctx: ExtensionCommandContext) => {
    const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
    const providers = Object.entries(loaded.settings.providers)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(", ");
    const disabledAccounts = Object.entries(loaded.settings.accounts)
      .filter(([, enabled]) => !enabled)
      .map(([id]) => id)
      .join(", ");
    ctx.ui.notify(
      [
        `Settings: ${loaded.path}`,
        `Accounts: ${loaded.settings.accountsDir}`,
        `Refresh: ${loaded.settings.refreshMinutes} min`,
        `Visible accounts: ${loaded.settings.maxVisibleAccounts}`,
        `Providers: ${providers || "none"}`,
        `Accounts disabled: ${disabledAccounts || "none"}`,
        `Hide emails: ${loaded.settings.hideEmails ? "yes" : "no"}`,
        `Source: ${Object.keys(loaded.raw).length ? "settings file" : "defaults"}`,
      ].join("\n"),
      loaded.warnings.length ? "warning" : "info",
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
    if (loaded.warnings.length && ctx.hasUI) {
      ctx.ui.notify(loaded.warnings.join("; "), "warning");
    }
    await refresh(ctx);
    scheduleRefresh(ctx, loaded.settings.refreshMinutes);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    clearUsage(ctx);
  });

  pi.registerCommand("cliproxy-usage", {
    description: "Configure CLIProxyAPI usage monitoring and account settings",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trim().toLowerCase();
      const matches = COMMAND_ARGUMENTS.filter((item) => item.value.startsWith(value));
      return matches.length ? [...matches] : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!action || action === "settings" || action === "config") {
        return showSettings(ctx, SETTINGS_PATH, LEGACY_SETTINGS_PATH, (settings, changedId) =>
          applySettings(ctx, settings, changedId),
        );
      }
      if (action === "refresh") return refresh(ctx, true);
      if (action === "status") return showStatus(ctx);
      if (action === "help") {
        ctx.ui.notify(
          [
            "/cliproxy-usage — open settings",
            "/cliproxy-usage settings — edit settings",
            "/cliproxy-usage config — alias for settings",
            "/cliproxy-usage refresh — refresh usage",
            "/cliproxy-usage status — show effective settings",
            "/cliproxy-usage help — show this help",
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
