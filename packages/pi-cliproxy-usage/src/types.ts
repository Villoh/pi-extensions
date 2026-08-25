export type ProviderName = "claude" | "codex" | "grok";

export type Settings = {
  accountsDir: string;
  refreshMinutes: number;
  maxVisibleAccounts: number;
  providers: Record<ProviderName, boolean>;
  /** Per-account enable flag, keyed by auth file name. Missing key means enabled. */
  accounts: Record<string, boolean>;
  /** Mask account emails (e.g. "j***@example.com") wherever labels are shown. */
  hideEmails: boolean;
};

export type Config = Settings;

export type AccountSummary = {
  id: string;
  label: string;
  provider: ProviderName;
};

export type UsageWindow = {
  used: number;
  resetsAt?: Date;
};

export type AccountUsage = {
  provider: ProviderName;
  label: string;
  session?: UsageWindow;
  weekly?: UsageWindow;
  error?: string;
};

export type Theme = {
  fg(color: string, text: string): string;
};

export type UiContext = {
  mode: string;
  ui: {
    theme: Theme;
    setStatus(id: string, text: string | undefined): void;
    setWidget(id: string, content: unknown, options?: { placement: "belowEditor" }): void;
    notify(message: string, level: "info" | "warning" | "error"): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
  };
};
