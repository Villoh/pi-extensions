import {
  type ExtensionCommandContext,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Input,
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { resolveManagementRoot } from "./management-client.js";
import { loadSettings, saveSettings } from "./settings.js";
import type { AccountSummary, ProviderName, SelectionMode, Settings } from "./types.js";
import { createSettingsBorder } from "./ui.js";
import { discoverAccounts } from "./usage.js";

const providerIds = new Set<ProviderName>(["claude", "codex", "grok", "deepseek"]);

function accountsSummary(accounts: AccountSummary[], enabled: Record<string, boolean>): string {
  if (accounts.length === 0) return "no accounts found";
  const enabledCount = accounts.filter((account) => enabled[account.id] !== false).length;
  return `${enabledCount}/${accounts.length} enabled`;
}

class MultiSelectSubmenu implements Component {
  private selectedIndex = 0;
  private readonly checked: Set<string>;

  constructor(
    private readonly options: { value: string; label: string }[],
    initiallyChecked: string[],
    private readonly theme: { fg(color: string, text: string): string },
    private readonly done: (value?: string) => void,
  ) {
    this.checked = new Set(initiallyChecked);
  }

  render(width: number): string[] {
    const hint = this.theme.fg("dim", "↑/↓ move · space toggle · enter confirm · esc cancel");
    const rows = this.options.map((option, index) => {
      const box = this.checked.has(option.value) ? "[x]" : "[ ]";
      const text = truncateToWidth(`${box} ${option.label}`, width);
      return index === this.selectedIndex ? this.theme.fg("accent", text) : text;
    });
    return [hint, ...rows];
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done([...this.checked].join(","));
      return;
    }
    if (matchesKey(data, Key.space)) {
      const option = this.options[this.selectedIndex];
      if (option) {
        if (this.checked.has(option.value)) this.checked.delete(option.value);
        else this.checked.add(option.value);
      }
      return;
    }
    if (matchesKey(data, Key.up)) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
    }
  }
}

function settingValue(settings: Settings, id: string): string {
  if (id === "selectionMode") return settings.selectionMode;
  if (id === "managementUrl") return settings.managementUrl || "(auto)";
  if (id === "refreshMinutes") return String(settings.refreshMinutes);
  if (id === "maxVisibleAccounts") return String(settings.maxVisibleAccounts);
  if (providerIds.has(id as ProviderName))
    return settings.providers[id as ProviderName] ? "enabled" : "disabled";
  if (id === "hideEmails") return settings.hideEmails ? "enabled" : "disabled";
  return "";
}

export async function showSettings(
  ctx: ExtensionCommandContext,
  settingsPath: string,
  legacySettingsPath: string,
  onChange: (settings: Settings, changedId: string) => Promise<void>,
): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify(`Edit settings manually: ${settingsPath}`, "info");
    return;
  }
  const loaded = await loadSettings(settingsPath, legacySettingsPath);
  if (!loaded.writable) {
    ctx.ui.notify(`Cannot edit invalid settings: ${loaded.warnings.join(", ")}`, "error");
    return;
  }
  let settings = loaded.settings;
  let raw = loaded.raw;
  let saveQueue = Promise.resolve();
  const discovered = await discoverAccounts(settings);
  const accountOptions = discovered.map((account) => ({
    value: account.id,
    label: `${account.label} (${account.provider})`,
  }));
  const resolvedRoot = await resolveManagementRoot(settings);
  const dashboardUrl = "error" in resolvedRoot ? undefined : `${resolvedRoot.root}/management.html`;

  await ctx.ui.custom((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = [
      {
        id: "selectionMode",
        label: "Account selection",
        description: "Auto follows the active model; manual shows selected accounts",
        currentValue: settings.selectionMode,
        values: ["auto", "manual"],
      },
      {
        id: "managementUrl",
        label: "Management URL override",
        description: "CLIProxyAPI root URL; leave empty to reuse the configured provider's baseUrl",
        currentValue: settings.managementUrl || "(auto)",
        submenu: (currentValue, close) => {
          const input = new Input();
          input.setValue(currentValue === "(auto)" ? "" : currentValue);
          input.onSubmit = (value) => close(value.trim());
          input.onEscape = () => close(undefined);
          return input;
        },
      },
      {
        id: "refreshMinutes",
        label: "Refresh interval (min)",
        description: "Minutes between automatic usage refreshes",
        currentValue: String(settings.refreshMinutes),
        values: ["1", "5", "10", "15", "30", "60"],
      },
      {
        id: "maxVisibleAccounts",
        label: "Visible accounts",
        description: "Maximum account rows shown below editor",
        currentValue: String(settings.maxVisibleAccounts),
        values: ["1", "2", "3", "4", "5", "10"],
      },
      ...(["claude", "codex", "grok", "deepseek"] as const).map((provider) => ({
        id: provider,
        label: `${provider[0]?.toUpperCase()}${provider.slice(1)}`,
        description: `Show ${provider} accounts`,
        currentValue: settings.providers[provider] ? "enabled" : "disabled",
        values: ["enabled", "disabled"],
      })),
      {
        id: "hideEmails",
        label: "Hide emails",
        description: "Mask account emails (e.g. j***@***.com) in labels",
        currentValue: settings.hideEmails ? "enabled" : "disabled",
        values: ["enabled", "disabled"],
      },
      ...(accountOptions.length > 0
        ? [
            {
              id: "accounts",
              label: "Accounts",
              description: "Enable or disable individual accounts (used in manual mode)",
              currentValue: accountsSummary(discovered, settings.accounts),
              submenu: (_currentValue: string, close: (value?: string) => void) =>
                new MultiSelectSubmenu(
                  accountOptions,
                  discovered
                    .filter((account) => settings.accounts[account.id] !== false)
                    .map((account) => account.id),
                  theme,
                  close,
                ),
            },
          ]
        : []),
    ];
    const container = new Container();
    container.addChild(createSettingsBorder(theme));
    container.addChild(
      new Text(theme.fg("accent", theme.bold("CLIProxyAPI Usage Settings")), 1, 1),
    );
    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, value) => {
        const previous = structuredClone(settings);
        if (id === "selectionMode") settings.selectionMode = value as SelectionMode;
        if (id === "managementUrl") settings.managementUrl = value === "(auto)" ? "" : value;
        if (id === "refreshMinutes") settings.refreshMinutes = Number(value);
        if (id === "maxVisibleAccounts") settings.maxVisibleAccounts = Number(value);
        if (id === "hideEmails") settings.hideEmails = value === "enabled";
        if (providerIds.has(id as ProviderName))
          settings.providers[id as ProviderName] = value === "enabled";
        if (id === "accounts") {
          const selected = new Set(value ? value.split(",") : []);
          for (const account of discovered)
            settings.accounts[account.id] = selected.has(account.id);
        }
        const next = structuredClone(settings);
        saveQueue = saveQueue
          .then(async () => {
            raw = await saveSettings(next, raw, settingsPath);
            await onChange(next, id);
          })
          .catch((error) => {
            settings = previous;
            list.updateValue(
              id,
              id === "accounts"
                ? accountsSummary(discovered, previous.accounts)
                : settingValue(previous, id),
            );
            ctx.ui.notify(`Failed to save settings: ${error.message}`, "error");
            tui.requestRender();
          });
      },
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(list);
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          `Password: ${settings.managementKey ? "configured (use /cliproxy-usage setup to change)" : "not set — run /cliproxy-usage setup"}${dashboardUrl ? `\nDashboard (if enabled): ${dashboardUrl}` : ""}\n${settingsPath}`,
        ),
        1,
        1,
      ),
    );
    container.addChild(createSettingsBorder(theme));
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
}
