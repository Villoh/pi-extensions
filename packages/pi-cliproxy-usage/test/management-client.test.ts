import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  apiCall,
  listAuthFiles,
  listDeepSeekAccounts,
  normalizeManagementUrl,
  normalizeProviderBaseUrl,
  resolveManagementRoot,
  validateManagementKey,
} from "../src/management-client.js";

test("normalizeProviderBaseUrl strips trailing slashes and a trailing /v1, preserves prefixes", () => {
  assert.equal(normalizeProviderBaseUrl("http://127.0.0.1:8317/"), "http://127.0.0.1:8317");
  assert.equal(normalizeProviderBaseUrl("http://127.0.0.1:8317/v1"), "http://127.0.0.1:8317");
  assert.equal(normalizeProviderBaseUrl("http://127.0.0.1:8317/v1/"), "http://127.0.0.1:8317");
  assert.equal(
    normalizeProviderBaseUrl("https://host/proxy/cliproxy/v1"),
    "https://host/proxy/cliproxy",
  );
});

test("normalizeManagementUrl strips a trailing /v0/management", () => {
  assert.equal(
    normalizeManagementUrl("http://127.0.0.1:8317/v0/management/"),
    "http://127.0.0.1:8317",
  );
  assert.equal(normalizeManagementUrl("http://127.0.0.1:8317"), "http://127.0.0.1:8317");
});

test("resolveManagementRoot prefers a configured managementUrl override", async () => {
  const resolved = await resolveManagementRoot({
    managementUrl: "http://tunnel:9000/v0/management",
  });
  assert.deepEqual(resolved, { root: "http://tunnel:9000" });
});

test("resolveManagementRoot falls back to cliproxyapi.json's baseUrl", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await writeFile(
      join(dir, "cliproxyapi.json"),
      JSON.stringify({ baseUrl: "http://127.0.0.1:8317/v1" }),
    );
    const resolved = await resolveManagementRoot({ managementUrl: "" });
    assert.deepEqual(resolved, { root: "http://127.0.0.1:8317" });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveManagementRoot errors when nothing is configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const resolved = await resolveManagementRoot({ managementUrl: "" });
    assert.ok("error" in resolved);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
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

test("validateManagementKey reports 401 without throwing", async () => {
  const result = await withFetch(
    () => new Response("{}", { status: 401 }),
    () => validateManagementKey("http://host", "wrong"),
  );
  assert.deepEqual(result, { ok: false, status: 401, message: "Management API HTTP 401" });
});

test("listAuthFiles groups by provider, mapping xai to grok and skipping disabled/unknown entries", async () => {
  const files = await withFetch(
    (url) => {
      assert.match(url, /\/v0\/management\/auth-files$/);
      return new Response(
        JSON.stringify({
          files: [
            { auth_index: "a1", provider: "claude", email: "me@example.com" },
            { auth_index: "a2", provider: "xai", label: "grok-team" },
            { auth_index: "a3", provider: "gemini" },
            { auth_index: "a4", provider: "codex", disabled: true },
          ],
        }),
      );
    },
    () => listAuthFiles("http://host", "key"),
  );
  assert.deepEqual(files.get("claude"), [
    { authIndex: "a1", provider: "claude", label: "me@example.com" },
  ]);
  assert.deepEqual(files.get("grok"), [{ authIndex: "a2", provider: "grok", label: "grok-team" }]);
  assert.equal(files.get("codex"), undefined);
});

test("listDeepSeekAccounts requires the exact api.deepseek.com hostname and never returns the api key", async () => {
  const accounts = await withFetch(
    () =>
      new Response(
        JSON.stringify([
          {
            name: "deepseek",
            "base-url": "https://api.deepseek.com/v1",
            "api-key-entries": [{ "api-key": "sk-secret", "auth-index": "d1" }],
          },
          {
            name: "not-deepseek",
            "base-url": "https://not-deepseek.com.evil/v1",
            "api-key-entries": [{ "api-key": "sk-secret2", "auth-index": "d2" }],
          },
        ]),
      ),
    () => listDeepSeekAccounts("http://host", "key"),
  );
  assert.deepEqual(accounts, [{ authIndex: "d1", provider: "deepseek", label: "deepseek" }]);
  assert.equal(JSON.stringify(accounts).includes("sk-secret"), false);
});

test("apiCall posts the proxy request and returns the upstream status/body", async () => {
  const result = await withFetch(
    async (url, init) => {
      assert.match(url, /\/v0\/management\/api-call$/);
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.auth_index, "a1");
      assert.equal(payload.url, "https://api.example.com/usage");
      return new Response(JSON.stringify({ status_code: 200, body: '{"ok":true}' }));
    },
    () =>
      apiCall("http://host", "key", {
        authIndex: "a1",
        method: "GET",
        url: "https://api.example.com/usage",
      }),
  );
  assert.deepEqual(result, { statusCode: 200, body: '{"ok":true}' });
});
