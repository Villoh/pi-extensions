export type ProviderName = "claude" | "codex" | "grok" | "deepseek";

export type SelectionMode = "auto" | "manual";

export type Settings = {
  /** Bearer/X-Management-Key password for CLIProxyAPI's Management API. Never displayed back to the user. */
  managementKey?: string;
  /** Management API root URL override. Empty means "reuse cliproxyapi.json's baseUrl". */
  managementUrl: string;
  /** Auto follows the active Pi model; manual refreshes all enabled providers/accounts. */
  selectionMode: SelectionMode;
  /** Provider-level enable/disable switches, used by both selection modes. */
  providers: Record<ProviderName, boolean>;
  /** Per-account overrides keyed by CLIProxyAPI auth_index. Missing means enabled. */
  accounts: Record<string, boolean>;
  /** Mask email labels in the widget and detailed output. */
  hideEmails: boolean;
  refreshMinutes: number;
  maxVisibleAccounts: number;
};

export type Config = Settings;

export type UsageWindow = {
  used: number;
  resetsAt?: Date;
};

export type AccountBalance = {
  amount: number;
  currency: string;
};

export type AccountUsage = {
  /** CLIProxyAPI auth_index, retained internally for manual account filtering. */
  id?: string;
  provider: ProviderName;
  label: string;
  session?: UsageWindow;
  weekly?: UsageWindow;
  /** Balance-based providers (e.g. DeepSeek) report remaining funds instead of a used percentage. */
  balance?: AccountBalance;
  error?: string;
};

export type Theme = {
  fg(color: string, text: string): string;
};

export type AccountSummary = {
  id: string;
  provider: ProviderName;
  label: string;
};

export type UiContext = {
  mode: string;
  model?: { provider?: string; id?: string };
  ui: {
    theme: Theme;
    setStatus(id: string, text: string | undefined): void;
    setWidget(id: string, content: unknown, options?: { placement: "belowEditor" }): void;
    notify(message: string, level: "info" | "warning" | "error"): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
  };
};
