import type { AccountUsage, UsageWindow } from "./types.js";

export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toDate(value: unknown): Date | undefined {
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  const raw = toNumber(value);
  if (raw === undefined) return undefined;
  return new Date(raw < 1e10 ? raw * 1000 : raw);
}

export function parseClaude(body: unknown): Pick<AccountUsage, "session" | "weekly"> {
  const root = body as Record<string, unknown>;
  const window = (value: unknown): UsageWindow | undefined => {
    const item = value as Record<string, unknown> | undefined;
    const used = toNumber(item?.utilization);
    return used === undefined ? undefined : { used, resetsAt: toDate(item?.resets_at) };
  };
  return { session: window(root?.five_hour), weekly: window(root?.seven_day) };
}

function codexWindow(value: unknown): (UsageWindow & { seconds?: number }) | undefined {
  const item = value as Record<string, unknown> | undefined;
  const used = toNumber(item?.used_percent);
  if (used === undefined) return undefined;
  const resetAfter = toNumber(item?.reset_after_seconds);
  return {
    used,
    seconds: toNumber(item?.limit_window_seconds),
    resetsAt:
      toDate(item?.reset_at) ??
      (resetAfter === undefined ? undefined : new Date(Date.now() + resetAfter * 1000)),
  };
}

export function parseCodex(body: unknown): Pick<AccountUsage, "session" | "weekly"> {
  const rate = (body as Record<string, unknown>)?.rate_limit as Record<string, unknown> | undefined;
  const windows = [codexWindow(rate?.primary_window), codexWindow(rate?.secondary_window)].filter(
    Boolean,
  ) as Array<UsageWindow & { seconds?: number }>;
  const session =
    windows.find((item) => item.seconds === 18_000) ??
    windows.find((item) => item.seconds !== 604_800) ??
    windows[0];
  const weekly = windows.find((item) => item.seconds === 604_800 && item !== session);
  return { session, weekly };
}

export function parseGrok(body: unknown): Pick<AccountUsage, "weekly"> {
  const config = (body as Record<string, unknown>)?.config as Record<string, unknown> | undefined;
  const period = config?.currentPeriod as Record<string, unknown> | undefined;
  if (period?.type !== "USAGE_PERIOD_TYPE_WEEKLY") return {};
  return {
    weekly: {
      used: toNumber(config?.creditUsagePercent) ?? 0,
      resetsAt: toDate(period.end),
    },
  };
}
