import assert from "node:assert/strict";
import test from "node:test";
import { parseClaude, parseCodex, parseDeepSeek, parseGrok, toNumber } from "../src/parsers.js";

test("toNumber accepts finite numbers and numeric strings", () => {
  assert.equal(toNumber(12.5), 12.5);
  assert.equal(toNumber(" 42 "), 42);
  assert.equal(toNumber(""), undefined);
  assert.equal(toNumber("nope"), undefined);
  assert.equal(toNumber(Number.POSITIVE_INFINITY), undefined);
  assert.equal(toNumber(null), undefined);
});

test("Claude parses optional windows and reset dates", () => {
  const usage = parseClaude({
    five_hour: { utilization: "25", resets_at: "2030-01-01T00:00:00Z" },
    seven_day: null,
  });
  assert.equal(usage.session?.used, 25);
  assert.equal(usage.session?.resetsAt?.toISOString(), "2030-01-01T00:00:00.000Z");
  assert.equal(usage.weekly, undefined);
  assert.deepEqual(parseClaude({}), { session: undefined, weekly: undefined });
});

test("Codex identifies session by five-hour duration regardless of slot, and reports weekly separately", () => {
  const usage = parseCodex({
    rate_limit: {
      primary_window: { used_percent: 20, limit_window_seconds: 604800 },
      secondary_window: {
        used_percent: "40",
        limit_window_seconds: 18000,
        reset_at: 1_893_456_000,
      },
    },
  });
  assert.equal(usage.session?.used, 40);
  assert.equal(usage.session?.resetsAt?.getTime(), 1_893_456_000_000);
  assert.equal(usage.weekly?.used, 20);
});

test("Codex falls back to primary window when durations are absent, with no weekly", () => {
  assert.equal(
    parseCodex({ rate_limit: { primary_window: { used_percent: 17 } } }).session?.used,
    17,
  );
  assert.equal(
    parseCodex({ rate_limit: { primary_window: { used_percent: 17 } } }).weekly,
    undefined,
  );
  assert.equal(parseCodex({}).session, undefined);
  assert.equal(parseCodex({}).weekly, undefined);
});

test("Codex without a five-hour window falls back to the only window as session, without duplicating it as weekly", () => {
  const usage = parseCodex({
    rate_limit: {
      primary_window: { used_percent: 55, limit_window_seconds: 604800 },
    },
  });
  assert.equal(usage.session?.used, 55);
  assert.equal(usage.weekly, undefined);
});

test("Grok only exposes weekly unified billing", () => {
  assert.deepEqual(
    parseGrok({
      config: {
        creditUsagePercent: 60,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          end: "2030-01-01T00:00:00Z",
        },
      },
    }),
    {
      weekly: {
        used: 60,
        resetsAt: new Date("2030-01-01T00:00:00Z"),
      },
    },
  );
  assert.deepEqual(
    parseGrok({
      config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" } },
    }),
    {},
  );
  assert.equal(
    parseGrok({
      config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } },
    }).weekly?.used,
    0,
  );
});

test("DeepSeek parses the first balance entry's total balance", () => {
  assert.deepEqual(parseDeepSeek({ balance_infos: [{ total_balance: "9.99", currency: "USD" }] }), {
    balance: { amount: 9.99, currency: "USD" },
  });
  assert.deepEqual(parseDeepSeek({ balance_infos: [] }), {});
  assert.deepEqual(parseDeepSeek({}), {});
});
