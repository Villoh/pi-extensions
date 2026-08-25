import type { AccountUsage, ProviderName, Theme, UiContext, UsageWindow } from "./types.js";

const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
};
const CLAUDE_ORANGE = "\u001b[38;5;208m";

function accountLabel(label: string): string {
  return label;
}

export function usageBar(used: number, width = 10): string {
  const percent = Math.max(0, Math.min(100, used));
  const filled = Math.round((percent / 100) * width);
  return "━".repeat(filled) + "─".repeat(width - filled);
}

export function formatCompact(items: AccountUsage[]): string {
  return items
    .map((item) => {
      if (item.error) {
        return `${PROVIDER_LABELS[item.provider]} ${accountLabel(item.label)}: ! ${item.error}`;
      }
      const windows = [
        item.session && `S ${usageBar(item.session.used)} ${Math.round(item.session.used)}%`,
        item.weekly && `W ${usageBar(item.weekly.used)} ${Math.round(item.weekly.used)}%`,
      ].filter(Boolean);
      return `${PROVIDER_LABELS[item.provider]} ${accountLabel(item.label)}  ${windows.join("  ") || "–"}`;
    })
    .join("\n");
}

export function formatDetails(items: AccountUsage[]): string {
  if (!items.length) return "No enabled CLIProxyAPI accounts found.";
  return items
    .map((item) => {
      if (item.error) return `${item.provider}/${item.label}: ${item.error}`;
      const windows = [
        item.session && `Session ${item.session.used.toFixed(0)}% used`,
        item.weekly && `Weekly ${item.weekly.used.toFixed(0)}% used`,
      ].filter(Boolean);
      return `${item.provider}/${item.label}: ${windows.join(" · ") || "No usage window"}`;
    })
    .join("\n");
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

export function renderUsage(
  ctx: UiContext,
  items: AccountUsage[],
  maxVisibleAccounts: number,
): void {
  ctx.ui.setStatus("cliproxy-usage", undefined);
  if (!items.length) {
    ctx.ui.setWidget("cliproxy-usage", undefined);
    return;
  }
  const visibleItems = items
    .map((item, index) => ({
      item,
      index,
      priority: item.error
        ? Number.POSITIVE_INFINITY
        : Math.max(item.session?.used ?? -1, item.weekly?.used ?? -1),
    }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .slice(0, maxVisibleAccounts)
    .map(({ item }) => item);
  const hiddenCount = items.length - visibleItems.length;
  const providerWidth = Math.max(
    ...visibleItems.map((item) => PROVIDER_LABELS[item.provider].length),
  );
  const accountWidth = Math.max(...visibleItems.map((item) => accountLabel(item.label).length));
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
            theme.fg("muted", accountLabel(item.label).padEnd(accountWidth)) +
            separator;
          if (item.error) {
            return truncateAnsi(`${prefix}${theme.fg("error", `! ${item.error}`)}`, width);
          }
          const meter = (name: string, usage: UsageWindow) => {
            const used = Math.max(0, Math.min(100, usage.used));
            const color = used >= 90 ? "error" : used >= 70 ? "warning" : "text";
            const filled = usageBar(used).replace(/─+$/, "");
            const empty = "─".repeat(10 - filled.length);
            return `${theme.fg("muted", name)} ${theme.fg(color, filled)}${theme.fg("dim", empty)} ${theme.fg(color, `${Math.round(used)}%`)}`;
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
