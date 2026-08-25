import {
  type ExtensionCommandContext,
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
import { loadSettings, saveSettings } from "./settings.js";
import type { ProviderName, Settings } from "./types.js";

const providerIds = new Set<ProviderName>(["claude", "codex", "grok"]);

function createSettingsBorder(theme: { fg(color: string, text: string): string }): Component {
  return {
    render: (width: number) => [theme.fg("border", "─".repeat(Math.max(1, width)))],
    invalidate: () => {},
  };
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

  await ctx.ui.custom((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = [
      {
        id: "accountsDir",
        label: "Accounts directory",
        description: "Directory containing CLIProxyAPI account JSON files",
        currentValue: settings.accountsDir,
        submenu: (currentValue, close) => {
          const input = new Input();
          input.setValue(currentValue);
          input.onSubmit = (value) => close(value.trim() || undefined);
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
      ...(["claude", "codex", "grok"] as const).map((provider) => ({
        id: provider,
        label: `${provider[0]?.toUpperCase()}${provider.slice(1)}`,
        description: `Show ${provider} accounts`,
        currentValue: settings.providers[provider] ? "enabled" : "disabled",
        values: ["enabled", "disabled"],
      })),
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
        if (id === "accountsDir") settings.accountsDir = value;
        if (id === "refreshMinutes") settings.refreshMinutes = Number(value);
        if (id === "maxVisibleAccounts") {
          settings.maxVisibleAccounts = Number(value);
        }
        if (providerIds.has(id as ProviderName)) {
          settings.providers[id as ProviderName] = value === "enabled";
        }
        const next = structuredClone(settings);
        saveQueue = saveQueue
          .then(async () => {
            raw = await saveSettings(next, raw, settingsPath);
            await onChange(next, id);
          })
          .catch((error) => {
            settings = previous;
            let previousValue: string;
            if (id === "accountsDir") previousValue = previous.accountsDir;
            else if (id === "refreshMinutes") {
              previousValue = String(previous.refreshMinutes);
            } else if (id === "maxVisibleAccounts") {
              previousValue = String(previous.maxVisibleAccounts);
            } else {
              previousValue = previous.providers[id as ProviderName] ? "enabled" : "disabled";
            }
            list.updateValue(id, previousValue);
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
        theme.fg("dim", `Accounts directory: ${settings.accountsDir}\n${settingsPath}`),
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
