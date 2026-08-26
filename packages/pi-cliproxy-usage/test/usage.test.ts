import assert from "node:assert/strict";
import test from "node:test";
import type { Settings } from "../src/types.js";
import { readProviderAccounts } from "../src/usage.js";

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  managementUrl: "http://host",
  managementKey: "secret",
  refreshMinutes: 5,
  maxVisibleAccounts: 4,
  providers: { claude: true, codex: true, grok: true, deepseek: true },
  ...overrides,
  selectionMode: overrides.selectionMode ?? "auto",
  accounts: overrides.accounts ?? {},
  hideEmails: overrides.hideEmails ?? false,
});

function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
  run: () => Promise<T>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => handler(url, init)) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("readProviderAccounts skips disabled providers without a network request", async () => {
  const result = await withFetch(
    () => {
      throw new Error("should not fetch");
    },
    () =>
      readProviderAccounts(
        settings({ providers: { claude: false, codex: true, grok: true, deepseek: true } }),
        "claude",
      ),
  );
  assert.deepEqual(result, { items: [] });
});

test("readProviderAccounts errors when no management password is configured", async () => {
  const result = await readProviderAccounts(settings({ managementKey: undefined }), "claude");
  assert.deepEqual(result, {
    error: "Management password not configured. Run /cliproxy-usage setup.",
  });
});

test("readProviderAccounts fetches quota for each account of the requested provider only", async () => {
  const result = await withFetch(
    (url, init) => {
      if (url.endsWith("/v0/management/auth-files")) {
        return new Response(
          JSON.stringify({
            files: [
              { auth_index: "a1", provider: "claude", email: "me@example.com" },
              { auth_index: "a2", provider: "codex", email: "other@example.com" },
            ],
          }),
        );
      }
      if (url.endsWith("/v0/management/api-call")) {
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.auth_index, "a1");
        assert.equal(payload.url, "https://api.anthropic.com/api/oauth/usage");
        return new Response(
          JSON.stringify({
            status_code: 200,
            body: JSON.stringify({ five_hour: { utilization: 30 } }),
          }),
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    () => readProviderAccounts(settings(), "claude"),
  );
  assert.deepEqual(result, {
    items: [
      {
        id: "a1",
        provider: "claude",
        label: "me@example.com",
        session: { used: 30, resetsAt: undefined },
        weekly: undefined,
      },
    ],
  });
});

test("readProviderAccounts filters disabled auth indexes in manual selection mode", async () => {
  const result = await withFetch(
    (url, init) => {
      if (url.endsWith("/v0/management/auth-files")) {
        return new Response(
          JSON.stringify({
            files: [
              { auth_index: "keep", provider: "xai", email: "keep@example.com" },
              { auth_index: "skip", provider: "xai", email: "skip@example.com" },
            ],
          }),
        );
      }
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.auth_index, "keep");
      return new Response(JSON.stringify({ status_code: 200, body: JSON.stringify({}) }));
    },
    () =>
      readProviderAccounts(
        settings({ selectionMode: "manual", accounts: { keep: true, skip: false } }),
        "grok",
      ),
  );
  assert.deepEqual(result, {
    items: [{ id: "keep", provider: "grok", label: "keep@example.com" }],
  });
});

test("readProviderAccounts reports a per-account error instead of failing the whole batch", async () => {
  const result = await withFetch(
    (url) => {
      if (url.endsWith("/v0/management/auth-files")) {
        return new Response(JSON.stringify({ files: [{ auth_index: "a1", provider: "xai" }] }));
      }
      return new Response(JSON.stringify({ status_code: 401, body: "{}" }));
    },
    () => readProviderAccounts(settings(), "grok"),
  );
  assert.deepEqual(result, {
    items: [{ id: "a1", provider: "grok", label: "a1", error: "HTTP 401" }],
  });
});

test("readProviderAccounts discovers DeepSeek accounts through openai-compatibility and never leaks the api key", async () => {
  const result = await withFetch(
    (url, init) => {
      if (url.endsWith("/v0/management/openai-compatibility")) {
        return new Response(
          JSON.stringify([
            {
              name: "deepseek",
              "base-url": "https://api.deepseek.com/v1",
              "api-key-entries": [{ "api-key": "sk-secret", "auth-index": "d1" }],
            },
          ]),
        );
      }
      if (url.endsWith("/v0/management/api-call")) {
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.url, "https://api.deepseek.com/user/balance");
        return new Response(
          JSON.stringify({
            status_code: 200,
            body: JSON.stringify({ balance_infos: [{ total_balance: "12.50", currency: "USD" }] }),
          }),
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    () => readProviderAccounts(settings(), "deepseek"),
  );
  assert.deepEqual(result, {
    items: [
      {
        id: "d1",
        provider: "deepseek",
        label: "deepseek",
        balance: { amount: 12.5, currency: "USD" },
      },
    ],
  });
});
