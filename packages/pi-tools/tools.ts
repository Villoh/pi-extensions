/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 * Tool selection persists across session reloads and respects branch navigation.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /tools to open the tool selector
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  type SettingItem,
  type SettingsListTheme,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// State persisted to session
interface ToolsState {
  enabledTools: string[];
}

function createBorder(theme: { fg(color: string, text: string): string }) {
  return {
    render: (width: number) => [theme.fg("border", "─".repeat(Math.max(1, width)))],
    invalidate: () => {},
  };
}

function getExtensionName(tool: ToolInfo): string {
  const source = tool.sourceInfo.source.trim();

  if (source.startsWith("npm:")) {
    return source.slice("npm:".length);
  }

  if (source === "builtin") {
    return "native";
  }

  if (source === "sdk") {
    return "sdk";
  }

  if (source.startsWith("git:")) {
    return (
      source
        .slice("git:".length)
        .split(/[\\/:]/)
        .filter(Boolean)
        .at(-1)
        ?.replace(/\.git$/, "") ?? source
    );
  }

  if (!["builtin", "cli", "local", "sdk"].includes(source)) {
    return source.split(/[\\/]/).filter(Boolean).at(-1) ?? source;
  }

  const path = tool.sourceInfo.path.trim();
  if (path.startsWith("<") && path.endsWith(">")) {
    return path.slice(1, -1).replace(/^(?:builtin|sdk):/, "");
  }

  return path.split(/[\\/]/).filter(Boolean).at(-2) ?? source;
}

const MAX_LABEL_WIDTH = 38;
const LABEL_GAP = 4;

class ToolSettingsList {
  private filteredItems: SettingItem[];
  private selectedIndex = 0;
  private readonly searchInput = new Input();

  constructor(
    private readonly items: SettingItem[],
    private readonly maxVisible: number,
    private readonly theme: SettingsListTheme,
    private readonly onChange: (id: string, newValue: string) => void,
    private readonly onCancel: () => void,
  ) {
    this.filteredItems = items;
  }

  updateValue(id: string, newValue: string) {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item) item.currentValue = newValue;
  }

  invalidate() {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    const lines = [...this.searchInput.render(width), ""];
    const displayItems = this.filteredItems;

    if (displayItems.length === 0) {
      lines.push(
        this.theme.hint(
          this.items.length === 0 ? "  No settings available" : "  No matching settings",
        ),
      );
      this.addHintLine(lines, width);
      return lines;
    }

    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        displayItems.length - this.maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, displayItems.length);
    const maxLabelWidth = Math.min(
      MAX_LABEL_WIDTH,
      Math.max(...this.items.map((item) => visibleWidth(item.label)), 1),
    );

    for (let i = startIndex; i < endIndex; i++) {
      const item = displayItems[i];
      if (!item) continue;

      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? this.theme.cursor : "  ";
      const label = truncateToWidth(item.label, maxLabelWidth, "");
      const paddedLabel = label + " ".repeat(maxLabelWidth - visibleWidth(label));
      const valueMaxWidth = Math.max(
        1,
        width - visibleWidth(prefix) - maxLabelWidth - LABEL_GAP - 2,
      );
      const value = this.theme.value(
        truncateToWidth(item.currentValue, valueMaxWidth, ""),
        isSelected,
      );

      lines.push(
        truncateToWidth(
          prefix + this.theme.label(paddedLabel, isSelected) + " ".repeat(LABEL_GAP) + value,
          width,
        ),
      );
    }

    if (startIndex > 0 || endIndex < displayItems.length) {
      lines.push(
        this.theme.hint(
          truncateToWidth(`  (${this.selectedIndex + 1}/${displayItems.length})`, width - 2, ""),
        ),
      );
    }

    const selectedItem = displayItems[this.selectedIndex];
    if (selectedItem?.description) {
      lines.push("");
      for (const line of wrapTextWithAnsi(selectedItem.description, width - 4)) {
        lines.push(this.theme.description(`  ${line}`));
      }
    }

    this.addHintLine(lines, width);
    return lines;
  }

  handleInput(data: string) {
    const keybindings = getKeybindings();
    const displayItems = this.filteredItems;

    if (keybindings.matches(data, "tui.select.up")) {
      if (displayItems.length > 0) {
        this.selectedIndex =
          this.selectedIndex === 0 ? displayItems.length - 1 : this.selectedIndex - 1;
      }
      return;
    }

    if (keybindings.matches(data, "tui.select.down")) {
      if (displayItems.length > 0) {
        this.selectedIndex =
          this.selectedIndex === displayItems.length - 1 ? 0 : this.selectedIndex + 1;
      }
      return;
    }

    if (
      keybindings.matches(data, "tui.select.confirm") ||
      (data === " " && this.searchInput.getValue().length === 0)
    ) {
      this.activateItem();
      return;
    }

    if (keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }

    this.searchInput.handleInput(data);
    this.filteredItems = fuzzyFilter(
      this.items,
      this.searchInput.getValue(),
      (item: SettingItem) => `${item.label} ${item.description ?? ""}`,
    );
    this.selectedIndex = 0;
  }

  private activateItem() {
    const item = this.filteredItems[this.selectedIndex];
    if (!item?.values?.length) return;

    const currentIndex = item.values.indexOf(item.currentValue);
    const newValue = item.values[(currentIndex + 1) % item.values.length];
    if (!newValue) return;

    item.currentValue = newValue;
    this.onChange(item.id, newValue);
  }

  private addHintLine(lines: string[], width: number) {
    lines.push("");
    lines.push(
      truncateToWidth(
        this.theme.hint("  Type to search · Enter/Space to change · Esc to cancel"),
        width,
        "",
      ),
    );
  }
}

export default function toolsExtension(pi: ExtensionAPI) {
  // Track enabled tools
  let enabledTools: Set<string> = new Set();
  let allTools: ToolInfo[] = [];

  // Persist current state
  function persistState() {
    pi.appendEntry<ToolsState>("tools-config", {
      enabledTools: Array.from(enabledTools),
    });
  }

  // Apply current tool selection
  function applyTools() {
    pi.setActiveTools(Array.from(enabledTools));
  }

  // Find the last tools-config entry in the current branch
  function restoreFromBranch(ctx: ExtensionContext) {
    allTools = pi.getAllTools();

    // Get entries in current branch only
    const branchEntries = ctx.sessionManager.getBranch();
    let savedTools: string[] | undefined;

    for (const entry of branchEntries) {
      if (entry.type === "custom" && entry.customType === "tools-config") {
        const data = entry.data as ToolsState | undefined;
        if (data?.enabledTools) {
          savedTools = data.enabledTools;
        }
      }
    }

    if (savedTools) {
      // Restore saved tool selection (filter to only tools that still exist)
      const allToolNames = allTools.map((t) => t.name);
      enabledTools = new Set(savedTools.filter((t: string) => allToolNames.includes(t)));
      applyTools();
    } else {
      // No saved state - sync with currently active tools
      enabledTools = new Set(pi.getActiveTools());
    }
  }

  // Register /tools command
  pi.registerCommand("tools", {
    description: "Enable/disable tools",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/tools requires TUI mode", "error");
        return;
      }

      // Refresh tool list
      allTools = pi.getAllTools();

      await ctx.ui.custom((tui, theme, _kb, done) => {
        // Include the extension name in the label so search can match it too.
        const items: SettingItem[] = allTools.map((tool) => {
          const extensionName = getExtensionName(tool);

          return {
            id: tool.name,
            label: `${tool.name} [${extensionName}]`,
            description: `Extension: ${extensionName}`,
            currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
            values: ["enabled", "disabled"],
          };
        });

        const container = new Container();
        container.addChild(createBorder(theme));
        container.addChild(
          new (class {
            render(_width: number) {
              return [theme.fg("accent", theme.bold("Tool Configuration")), ""];
            }
            invalidate() {}
          })(),
        );

        const settingsList = new ToolSettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id, newValue) => {
            // Update enabled state and apply immediately
            if (newValue === "enabled") {
              enabledTools.add(id);
            } else {
              enabledTools.delete(id);
            }
            applyTools();
            persistState();
          },
          () => {
            // Close dialog
            done(undefined);
          },
        );

        container.addChild(settingsList);
        container.addChild(createBorder(theme));

        const component = {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };

        return component;
      });
    },
  });

  // Restore state on session start
  pi.on("session_start", async (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  // Restore state when navigating the session tree
  pi.on("session_tree", async (_event, ctx) => {
    restoreFromBranch(ctx);
  });
}
