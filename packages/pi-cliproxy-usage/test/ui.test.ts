import assert from "node:assert/strict";
import test from "node:test";
import type { Theme, UiContext } from "../src/types.js";
import { formatCompact, formatDetails, renderUsage, usageBar } from "../src/ui.js";

test("usageBar clamps usage and supports custom widths", () => {
  assert.equal(usageBar(-10), "──────────");
  assert.equal(usageBar(0), "──────────");
  assert.equal(usageBar(25), "━━━───────");
  assert.equal(usageBar(50, 4), "━━──");
  assert.equal(usageBar(100), "━━━━━━━━━━");
  assert.equal(usageBar(150), "━━━━━━━━━━");
});

test("formatCompact renders full account labels and separates accounts", () => {
  assert.equal(
    formatCompact([
      {
        provider: "claude",
        label: "very-long-account-name@example.com",
        session: { used: 49.6 },
        weekly: { used: 100 },
      },
      { provider: "codex", label: "work", session: { used: 0 } },
    ]),
    [
      "Claude very-long-account-name@example.com  S ━━━━━───── 50%  W ━━━━━━━━━━ 100%",
      "Codex work  S ────────── 0%",
    ].join("\n"),
  );
});

test("renderUsage colors Claude orange and Codex/Grok white", () => {
  let widget: unknown;
  const colors: string[] = [];
  const theme: Theme = {
    fg: (color, text) => {
      colors.push(color);
      return text;
    },
  };
  const ctx = {
    mode: "interactive",
    ui: {
      theme,
      setStatus() {},
      setWidget: (_id, content) => {
        widget = content;
      },
      notify() {},
      select: async () => undefined,
      input: async () => undefined,
    },
  } satisfies UiContext;

  renderUsage(
    ctx,
    [
      {
        provider: "claude",
        label: "user@example.com",
        session: { used: 50 },
      },
    ],
    4,
  );
  const factory = widget as (tui: unknown, theme: Theme) => { render(width: number): string[] };
  assert.equal(
    factory(undefined, theme).render(100)[0],
    "\u001b[38;5;208mClaude\u001b[0m │ user@example.com │ S ━━━━━─────  50%\u001b[0m",
  );
  assert.equal(colors.filter((color) => color === "text").length, 2);

  colors.length = 0;
  renderUsage(
    ctx,
    [
      { provider: "codex", label: "work" },
      { provider: "grok", label: "team" },
    ],
    4,
  );
  (widget as (tui: unknown, theme: Theme) => { render(width: number): string[] })(
    undefined,
    theme,
  ).render(100);
  assert.equal(colors.filter((color) => color === "text").length, 2);
});

test("renderUsage aligns separators across providers and accounts", () => {
  let widget: unknown;
  const theme: Theme = { fg: (_color, text) => text };
  const ctx = {
    mode: "interactive",
    ui: {
      theme,
      setStatus() {},
      setWidget: (_id, content) => {
        widget = content;
      },
      notify() {},
      select: async () => undefined,
      input: async () => undefined,
    },
  } satisfies UiContext;

  renderUsage(
    ctx,
    [
      { provider: "claude", label: "a", session: { used: 50 } },
      { provider: "codex", label: "long", session: { used: 0 } },
    ],
    4,
  );
  const factory = widget as (tui: unknown, theme: Theme) => { render(width: number): string[] };
  assert.deepEqual(factory(undefined, theme).render(100), [
    "\u001b[38;5;208mClaude\u001b[0m │ a    │ S ━━━━━─────  50%\u001b[0m",
    "Codex  │ long │ S ──────────   0%\u001b[0m",
  ]);
});

test("renderUsage keeps weekly meters aligned when percentages have different digit counts", () => {
  let widget: unknown;
  const theme: Theme = { fg: (_color, text) => text };
  const ctx = {
    mode: "interactive",
    ui: {
      theme,
      setStatus() {},
      setWidget: (_id, content) => {
        widget = content;
      },
      notify() {},
      select: async () => undefined,
      input: async () => undefined,
    },
  } satisfies UiContext;
  renderUsage(
    ctx,
    [
      { provider: "codex", label: "long", session: { used: 22 }, weekly: { used: 19 } },
      { provider: "codex", label: "short", session: { used: 4 }, weekly: { used: 9 } },
    ],
    4,
  );
  const factory = widget as (tui: unknown, theme: Theme) => { render(width: number): string[] };
  const lines = factory(undefined, theme).render(100);
  const weeklyStarts = lines.map((line) => line.indexOf("W "));
  assert.equal(weeklyStarts[0], weeklyStarts[1]);
});

test("renderUsage limits rows and prioritizes errors then highest usage", () => {
  let widget: unknown;
  const theme: Theme = { fg: (_color, text) => text };
  const ctx = {
    mode: "interactive",
    ui: {
      theme,
      setStatus() {},
      setWidget: (_id, content) => {
        widget = content;
      },
      notify() {},
      select: async () => undefined,
      input: async () => undefined,
    },
  } satisfies UiContext;

  renderUsage(
    ctx,
    [
      { provider: "claude", label: "low", session: { used: 10 } },
      { provider: "codex", label: "high", session: { used: 90 } },
      { provider: "grok", label: "broken", error: "HTTP 401" },
    ],
    2,
  );
  const factory = widget as (tui: unknown, theme: Theme) => { render(width: number): string[] };
  const lines = factory(undefined, theme).render(100);
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /broken/);
  assert.match(lines[1] ?? "", /high/);
  assert.equal(lines[2], "… 1 more account · /cliproxy-usage for details\u001b[0m");
});

test("formatCompact handles errors and missing windows", () => {
  assert.equal(
    formatCompact([
      { provider: "grok", label: "x", error: "HTTP 401" },
      { provider: "codex", label: "empty" },
    ]),
    "Grok x: ! HTTP 401\nCodex empty  –",
  );
});

test("formatDetails handles empty, success, errors, and missing data", () => {
  assert.equal(formatDetails([]), "No enabled CLIProxyAPI accounts found.");
  assert.equal(
    formatDetails([
      {
        provider: "claude",
        label: "me",
        session: { used: 12.6 },
        weekly: { used: 44.4 },
      },
      { provider: "grok", label: "bad", error: "HTTP 403" },
      { provider: "codex", label: "empty" },
    ]),
    [
      "claude/me: Session 13% used · Weekly 44% used",
      "grok/bad: HTTP 403",
      "codex/empty: No usage window",
    ].join("\n"),
  );
});

test("formatDetails includes a reset countdown when the upstream API supplies a timestamp", () => {
  const resetsAt = new Date(Date.now() + 2 * 60 * 60_000 + 15 * 60_000);
  assert.equal(
    formatDetails([{ provider: "claude", label: "me", session: { used: 50, resetsAt } }]),
    "claude/me: Session 50% used (resets in 2h 15m)",
  );
});

test("formatDetails and formatCompact mask email labels when requested", () => {
  const item = { provider: "claude" as const, label: "john@example.com", session: { used: 10 } };
  assert.equal(formatDetails([item], true), "claude/j***@***.com: Session 10% used");
  assert.match(formatCompact([item], true), /Claude j\*\*\*@\*\*\*\.com/);
});

test("formatDetails and formatCompact render DeepSeek balances instead of a percentage", () => {
  const item = {
    provider: "deepseek" as const,
    label: "deepseek",
    balance: { amount: 9.99, currency: "USD" },
  };
  assert.equal(formatDetails([item]), "deepseek/deepseek: Balance 9.99 USD");
  assert.equal(formatCompact([item]), "DeepSeek deepseek  9.99 USD");
});
