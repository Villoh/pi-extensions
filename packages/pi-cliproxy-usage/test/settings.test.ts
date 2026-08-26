import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from "../src/settings.js";

test("loadSettings uses defaults when file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-settings-"));
  try {
    const loaded = await loadSettings(join(dir, "settings.json"), join(dir, "old.json"));
    assert.deepEqual(loaded.settings, DEFAULT_SETTINGS);
    assert.equal(loaded.writable, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalizeSettings validates values and preserves raw fields", () => {
  const loaded = normalizeSettings({
    managementUrl: 1,
    managementKey: "",
    refreshMinutes: 10,
    maxVisibleAccounts: 0,
    providers: { claude: false, codex: "yes", future: true },
    future: { enabled: true },
  });
  assert.equal(loaded.settings.managementUrl, DEFAULT_SETTINGS.managementUrl);
  assert.equal(loaded.settings.managementKey, undefined);
  assert.equal(loaded.settings.refreshMinutes, 10);
  assert.equal(loaded.settings.maxVisibleAccounts, DEFAULT_SETTINGS.maxVisibleAccounts);
  assert.equal(loaded.settings.providers.claude, false);
  assert.deepEqual(loaded.raw.future, { enabled: true });
  assert.deepEqual(loaded.warnings, [
    "ignored invalid managementUrl",
    "ignored invalid maxVisibleAccounts",
    "ignored invalid providers.codex",
  ]);
});

test("normalizeSettings accepts manual selection, account toggles, and email masking", () => {
  const loaded = normalizeSettings({
    selectionMode: "manual",
    accounts: { a1: false, a2: true },
    hideEmails: true,
  });
  assert.equal(loaded.settings.selectionMode, "manual");
  assert.deepEqual(loaded.settings.accounts, { a1: false, a2: true });
  assert.equal(loaded.settings.hideEmails, true);
});

test("normalizeSettings accepts managementUrl and managementKey", () => {
  const loaded = normalizeSettings({
    managementUrl: "http://127.0.0.1:8317/v1",
    managementKey: "secret",
  });
  assert.equal(loaded.settings.managementUrl, "http://127.0.0.1:8317/v1");
  assert.equal(loaded.settings.managementKey, "secret");
});

test("loadSettings blocks writes for malformed JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-settings-"));
  try {
    const path = join(dir, "settings.json");
    await writeFile(path, "{");
    const loaded = await loadSettings(path, join(dir, "old.json"));
    assert.equal(loaded.writable, false);
    assert.equal(loaded.warnings.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveSettings preserves unknown fields and account selection settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-settings-"));
  try {
    const path = join(dir, "settings.json");
    await saveSettings(
      { ...DEFAULT_SETTINGS, refreshMinutes: 15 },
      {
        future: true,
        providers: { future: false },
        accountsDir: "~/.cli-proxy-api",
        accounts: { a: true },
        hideEmails: true,
      },
      path,
    );
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.future, true);
    assert.equal(saved.providers.future, false);
    assert.equal(saved.refreshMinutes, 15);
    assert.equal(saved.accountsDir, undefined);
    assert.deepEqual(saved.accounts, {});
    assert.equal(saved.hideEmails, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveSettings removes managementKey when set to undefined (logout)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-settings-"));
  try {
    const path = join(dir, "settings.json");
    await saveSettings({ ...DEFAULT_SETTINGS, managementKey: "secret" }, {}, path);
    await saveSettings(
      { ...DEFAULT_SETTINGS, managementKey: undefined },
      { managementKey: "secret" },
      path,
    );
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.managementKey, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSettings migrates legacy bytes to canonical path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-settings-"));
  try {
    const canonical = join(dir, "pi-cliproxy-usage.json");
    const legacy = join(dir, "extensions", "pi-cliproxy-usage", "config.json");
    await mkdir(dirname(legacy), { recursive: true });
    const bytes = `${JSON.stringify({ refreshMinutes: 30 }, null, 2)}\n`;
    await writeFile(legacy, bytes);
    const loaded = await loadSettings(canonical, legacy);
    assert.equal(loaded.settings.refreshMinutes, 30);
    assert.equal(await readFile(canonical, "utf8"), bytes);
    await assert.rejects(readFile(legacy, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
