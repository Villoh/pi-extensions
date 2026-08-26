import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { resolveManagementRoot, validateManagementKey } from "./management-client.js";
import { loadSettings, saveSettings } from "./settings.js";
import type { Theme } from "./types.js";
import { createSettingsBorder } from "./ui.js";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function hasControlChars(data: string): boolean {
  return [...data].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
  });
}

/**
 * Minimal masked single-line input. pi-tui's Input component has no mask mode, and a password
 * field doesn't need its undo/kill-ring sophistication, so this reimplements only
 * insert/backspace/submit/cancel plus bracketed-paste unwrapping (terminals send pasted text
 * wrapped in \x1b[200~ ... \x1b[201~; without unwrapping it, the escape bytes look like control
 * chars and paste is silently dropped). ponytail: no cursor movement; add if needed.
 */
class PasswordInput implements Component {
  private value = "";
  private isPasting = false;
  private pasteBuffer = "";

  constructor(
    private readonly theme: Theme,
    private readonly done: (value?: string) => void,
  ) {}

  render(width: number): string[] {
    const line = `${this.theme.fg("dim", "Management password: ")}${"•".repeat(this.value.length)}`;
    return [truncateToWidth(line, width)];
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (!this.isPasting && data.includes(PASTE_START)) {
      this.isPasting = true;
      data = data.slice(data.indexOf(PASTE_START) + PASTE_START.length);
    }
    if (this.isPasting) {
      this.pasteBuffer += data;
      const endIndex = this.pasteBuffer.indexOf(PASTE_END);
      if (endIndex === -1) return;
      this.value += this.pasteBuffer.slice(0, endIndex).replace(/[\r\n\t]/g, "");
      const remaining = this.pasteBuffer.slice(endIndex + PASTE_END.length);
      this.isPasting = false;
      this.pasteBuffer = "";
      if (remaining) this.handleInput(remaining);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(this.value);
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\x7f") {
      this.value = this.value.slice(0, -1);
      return;
    }
    if (!hasControlChars(data)) this.value += data;
  }
}

/** Prompts for the CLIProxyAPI management password, validates it, and saves it on success. */
export async function runSetup(
  ctx: ExtensionCommandContext,
  settingsPath: string,
  legacyPath: string,
): Promise<void> {
  const loaded = await loadSettings(settingsPath, legacyPath);
  if (!loaded.writable) {
    ctx.ui.notify(`Cannot edit invalid settings: ${loaded.warnings.join(", ")}`, "error");
    return;
  }
  const resolved = await resolveManagementRoot(loaded.settings);
  if ("error" in resolved) {
    ctx.ui.notify(resolved.error, "error");
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      `Interactive setup requires the TUI. Edit ${settingsPath} manually and set "managementKey".`,
      "warning",
    );
    return;
  }

  const dashboardUrl = `${resolved.root}/management.html`;
  const password = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const input = new PasswordInput(theme, done);
    const container = new Container();
    container.addChild(createSettingsBorder(theme));
    container.addChild(
      new Text(theme.fg("accent", theme.bold("CLIProxyAPI Management Setup")), 1, 1),
    );
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          `${resolved.root}\nDashboard (if enabled): ${dashboardUrl}\nPaste or type, Enter to confirm, Esc to cancel`,
        ),
        1,
        1,
      ),
    );
    container.addChild({
      render: (width: number) => input.render(width),
      invalidate: () => input.invalidate(),
    });
    container.addChild(createSettingsBorder(theme));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        input.handleInput(data);
        tui.requestRender();
      },
    };
  });
  if (!password) {
    ctx.ui.notify("Setup cancelled.", "info");
    return;
  }

  const result = await validateManagementKey(resolved.root, password);
  if (!result.ok) {
    // Do not automatically retry the rejected password — CLIProxyAPI temporarily bans an IP
    // after repeated management-auth failures. Re-running setup is an explicit new attempt.
    const message =
      result.status === 401 || result.status === 403
        ? "Password rejected by CLIProxyAPI. Run /cliproxy-usage setup again to try another password."
        : `Could not reach ${resolved.root}: ${result.message}`;
    ctx.ui.notify(message, "error");
    return;
  }

  const next = { ...loaded.settings, managementKey: password };
  await saveSettings(next, loaded.raw, settingsPath);
  ctx.ui.notify(
    `Management password saved for ${resolved.root}. Dashboard (if enabled): ${dashboardUrl}`,
    "info",
  );
}

/** Removes the saved management password. */
export async function runLogout(
  ctx: ExtensionCommandContext,
  settingsPath: string,
  legacyPath: string,
): Promise<boolean> {
  const loaded = await loadSettings(settingsPath, legacyPath);
  if (!loaded.settings.managementKey) {
    ctx.ui.notify("No management password saved.", "info");
    return false;
  }
  const next = { ...loaded.settings, managementKey: undefined };
  await saveSettings(next, loaded.raw, settingsPath);
  ctx.ui.notify("Management password removed.", "info");
  return true;
}
