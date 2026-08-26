import type { AccountUsage, ProviderName, Theme, UiContext, UsageWindow } from "./types.js";

const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  deepseek: "DeepSeek",
};
const CLAUDE_ORANGE = "\u001b[38;5;208m";

/** Shared bordered-box chrome for /cliproxy-usage's interactive settings and setup screens. */
export function createSettingsBorder(theme: Theme) {
  return {
    render: (width: number) => [theme.fg("border", "─".repeat(Math.max(1, width)))],
    invalidate: () => {},
  };
}

function maskPart(part: string): string {
  return part ? `${part[0]}${"*".repeat(Math.max(part.length - 1, 3))}` : part;
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${maskPart(email.slice(0, at))}@***${tld}`;
}

function accountLabel(item: AccountUsage, hideEmails: boolean): string {
  return hideEmails && item.label.includes("@") ? maskEmail(item.label) : item.label;
}

export function usageBar(used: number, width = 10): string {
  const percent = Math.max(0, Math.min(100, used));
  const filled = Math.round((percent / 100) * width);
  return "━".repeat(filled) + "─".repeat(width - filled);
}

function formatBalance(balance: NonNullable<AccountUsage["balance"]>): string {
  return `${balance.amount.toFixed(2)} ${balance.currency}`;
}

/** "resets in 2h 15m" style countdown from now until a reset timestamp. */
function formatCountdown(resetsAt: Date): string | undefined {
  const ms = resetsAt.getTime() - Date.now();
  if (ms <= 0) return undefined;
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [hours && `${hours}h`, minutes && `${minutes}m`].filter(Boolean);
  return `resets in ${parts.length ? parts.join(" ") : "<1m"}`;
}

export type ReportRow = {
  label: string;
  value: string;
  tone?: "error" | "warning";
};

export type UsageReport = {
  title: string;
  sections: { title: string; rows: ReportRow[] }[];
  footer?: string;
};

type ReportTheme = Theme & { bold(text: string): string };

/** Format a report like Pi's built-in /session view: titled sections with dim labels. */
export function renderReport(report: UsageReport, theme: ReportTheme): string {
  const sections = report.sections.map((section) => {
    const rows = section.rows.map(({ label, value, tone }) => {
      const text = `${theme.fg("dim", `${label}:`)} ${value}`;
      return tone ? theme.fg(tone, text) : text;
    });
    return [theme.bold(section.title), ...rows].join("\n");
  });
  return [theme.bold(report.title), ...sections, report.footer && theme.fg("dim", report.footer)]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

export function formatCompact(items: AccountUsage[], hideEmails = false): string {
  return items
    .map((item) => {
      const label = accountLabel(item, hideEmails);
      if (item.error) return `${PROVIDER_LABELS[item.provider]} ${label}: ! ${item.error}`;
      if (item.balance)
        return `${PROVIDER_LABELS[item.provider]} ${label}  ${formatBalance(item.balance)}`;
      const windows = [
        item.session && `S ${usageBar(item.session.used)} ${Math.round(item.session.used)}%`,
        item.weekly && `W ${usageBar(item.weekly.used)} ${Math.round(item.weekly.used)}%`,
      ].filter(Boolean);
      return `${PROVIDER_LABELS[item.provider]} ${label}  ${windows.join("  ") || "–"}`;
    })
    .join("\n");
}

/** Includes reset countdowns; the compact widget intentionally omits them. */
export function createUsageReport(items: AccountUsage[], hideEmails = false): UsageReport {
  const sections = items.map((item) => {
    const label = accountLabel(item, hideEmails);
    if (item.error)
      return {
        title: `${PROVIDER_LABELS[item.provider]} · ${label}`,
        rows: [{ label: "Error", value: item.error, tone: "error" as const }],
      };
    if (item.balance)
      return {
        title: `${PROVIDER_LABELS[item.provider]} · ${label}`,
        rows: [{ label: "Balance", value: formatBalance(item.balance) }],
      };
    const window = (name: string, usage?: UsageWindow): ReportRow | undefined => {
      if (!usage) return undefined;
      const countdown = usage.resetsAt && formatCountdown(usage.resetsAt);
      return {
        label: name,
        value: `${usageBar(usage.used)} ${usage.used.toFixed(0)}%${countdown ? ` · ${countdown}` : ""}`,
      };
    };
    const rows = [window("Session", item.session), window("Weekly", item.weekly)].filter(
      (value): value is ReportRow => Boolean(value),
    );
    return {
      title: `${PROVIDER_LABELS[item.provider]} · ${label}`,
      rows: rows.length ? rows : [{ label: "Usage", value: "No usage window" }],
    };
  });
  return {
    title: "CLIProxyAPI Usage",
    sections: sections.length
      ? sections
      : [{ title: "Accounts", rows: [{ label: "Status", value: "No enabled accounts found." }] }],
    footer: "/cliproxy-usage refresh · settings",
  };
}

function truncateAnsi(text: string, width: number): string {
  let visible = 0;
  let result = "";
  for (let index = 0; index < text.length && visible < width; ) {
    if (text[index] === "\u001b") {
      const match = text.slice(index).match(/^\u001b\[[0-?]*[ -/]*[@-~]/);
      if (match) {
        result += match[0];
        index += match[0].length;
        continue;
      }
    }
    const point = text.codePointAt(index);
    if (point === undefined) break;
    result += String.fromCodePoint(point);
    index += point > 0xffff ? 2 : 1;
    visible++;
  }
  return `${result}\u001b[0m`;
}

export function clearUsage(ctx: UiContext): void {
  ctx.ui.setStatus("cliproxy-usage", undefined);
  ctx.ui.setWidget("cliproxy-usage", undefined);
}

/**
 * Balance items don't share units with percentage-used windows, so "least remaining" for them
 * is approximated with fixed low/mid/healthy thresholds rather than a true unified ranking.
 * ponytail: revisit with a configurable low-balance threshold if this misranks in practice.
 */
function priority(item: AccountUsage): number {
  if (item.error) return Number.POSITIVE_INFINITY;
  if (item.balance)
    return item.balance.amount <= 0
      ? 100
      : item.balance.amount < 5
        ? 90
        : item.balance.amount < 20
          ? 40
          : 0;
  return Math.max(item.session?.used ?? -1, item.weekly?.used ?? -1);
}

export function renderUsage(
  ctx: UiContext,
  items: AccountUsage[],
  maxVisibleAccounts: number,
  hideEmails = false,
): void {
  ctx.ui.setStatus("cliproxy-usage", undefined);
  if (!items.length) {
    ctx.ui.setWidget("cliproxy-usage", undefined);
    return;
  }
  const visibleItems = items
    .map((item, index) => ({ item, index, priority: priority(item) }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .slice(0, maxVisibleAccounts)
    .map(({ item }) => item);
  const hiddenCount = items.length - visibleItems.length;
  const providerWidth = Math.max(
    ...visibleItems.map((item) => PROVIDER_LABELS[item.provider].length),
  );
  const accountWidth = Math.max(
    ...visibleItems.map((item) => accountLabel(item, hideEmails).length),
  );
  ctx.ui.setWidget(
    "cliproxy-usage",
    (_tui: unknown, theme: Theme) => ({
      invalidate() {},
      render(width: number): string[] {
        const lines = visibleItems.map((item) => {
          const providerText = PROVIDER_LABELS[item.provider].padEnd(providerWidth);
          const providerLabel =
            item.provider === "claude"
              ? `${CLAUDE_ORANGE}${providerText}\u001b[0m`
              : theme.fg("text", providerText);
          const separator = theme.fg("dim", " │ ");
          const prefix =
            providerLabel +
            separator +
            theme.fg("muted", accountLabel(item, hideEmails).padEnd(accountWidth)) +
            separator;
          if (item.error) {
            return truncateAnsi(`${prefix}${theme.fg("error", `! ${item.error}`)}`, width);
          }
          if (item.balance) {
            const color =
              item.balance.amount < 5 ? "error" : item.balance.amount < 20 ? "warning" : "text";
            return truncateAnsi(`${prefix}${theme.fg(color, formatBalance(item.balance))}`, width);
          }
          const meter = (name: string, usage: UsageWindow) => {
            const used = Math.max(0, Math.min(100, usage.used));
            const color = used >= 90 ? "error" : used >= 70 ? "warning" : "text";
            const filled = usageBar(used).replace(/─+$/, "");
            const empty = "─".repeat(10 - filled.length);
            const percent = String(Math.round(used)).padStart(3, " ");
            return `${theme.fg("muted", name)} ${theme.fg(color, filled)}${theme.fg("dim", empty)} ${theme.fg(color, `${percent}%`)}`;
          };
          const windows = [
            item.session && meter("S", item.session),
            item.weekly && meter("W", item.weekly),
          ].filter(Boolean);
          return truncateAnsi(`${prefix}${windows.join(theme.fg("dim", "  │  "))}`, width);
        });
        if (hiddenCount) {
          lines.push(
            truncateAnsi(
              theme.fg(
                "dim",
                `… ${hiddenCount} more account${hiddenCount === 1 ? "" : "s"} · /cliproxy-usage for details`,
              ),
              width,
            ),
          );
        }
        return lines;
      },
    }),
    { placement: "belowEditor" },
  );
}
