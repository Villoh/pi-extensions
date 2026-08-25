import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "../src/types.js";
import { discoverAccounts, readAccounts } from "../src/usage.js";

const config = (accountsDir: string): Config => ({
  accountsDir,
  refreshMinutes: 5,
  maxVisibleAccounts: 4,
  providers: { claude: true, codex: true, grok: true },
  accounts: {},
  hideEmails: false,
});

test("readAccounts returns empty for missing directory", async () => {
  assert.deepEqual(await readAccounts(config(join(tmpdir(), "missing-cliproxy-dir"))), []);
});

test("readAccounts skips malformed, unknown, disabled, and disabled-provider files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-usage-"));
  try {
    await Promise.all([
      writeFile(join(dir, "broken.json"), "{"),
      writeFile(join(dir, "unknown.json"), JSON.stringify({ type: "gemini", access_token: "x" })),
      writeFile(
        join(dir, "disabled.json"),
        JSON.stringify({ type: "claude", access_token: "x", disabled: true }),
      ),
      writeFile(join(dir, "ignored.txt"), JSON.stringify({ type: "claude", access_token: "x" })),
    ]);
    const value = config(dir);
    value.providers.claude = false;
    await writeFile(
      join(dir, "provider-off.json"),
      JSON.stringify({ type: "claude", access_token: "x" }),
    );
    assert.deepEqual(await readAccounts(value), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readAccounts reports missing token without making a request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-usage-"));
  try {
    await writeFile(
      join(dir, "xai-local.json"),
      JSON.stringify({ type: "xai", email: "me@example.com" }),
    );
    assert.deepEqual(await readAccounts(config(dir)), [
      {
        provider: "grok",
        label: "me@example.com",
        error: "missing access_token",
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readAccounts skips accounts disabled individually via config.accounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-usage-"));
  try {
    await writeFile(
      join(dir, "xai-local.json"),
      JSON.stringify({ type: "xai", email: "me@example.com" }),
    );
    const value = config(dir);
    value.accounts["xai-local.json"] = false;
    assert.deepEqual(await readAccounts(value), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverAccounts lists available accounts regardless of enabled state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-usage-"));
  try {
    await Promise.all([
      writeFile(
        join(dir, "xai-local.json"),
        JSON.stringify({ type: "xai", email: "me@example.com" }),
      ),
      writeFile(join(dir, "broken.json"), "{"),
      writeFile(
        join(dir, "disabled.json"),
        JSON.stringify({ type: "claude", access_token: "x", disabled: true }),
      ),
    ]);
    assert.deepEqual(await discoverAccounts({ accountsDir: dir, hideEmails: false }), [
      { id: "xai-local.json", label: "me@example.com", provider: "grok" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverAccounts masks emails when hideEmails is enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-usage-"));
  try {
    await writeFile(
      join(dir, "xai-local.json"),
      JSON.stringify({ type: "xai", email: "me@example.com" }),
    );
    assert.deepEqual(await discoverAccounts({ accountsDir: dir, hideEmails: true }), [
      { id: "xai-local.json", label: "m***@***.com", provider: "grok" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readAccounts masks the reported label's email when hideEmails is enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-usage-"));
  try {
    await writeFile(
      join(dir, "xai-local.json"),
      JSON.stringify({ type: "xai", email: "me@example.com" }),
    );
    const value = config(dir);
    value.hideEmails = true;
    assert.deepEqual(await readAccounts(value), [
      { provider: "grok", label: "m***@***.com", error: "missing access_token" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
