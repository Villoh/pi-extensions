// @ts-nocheck

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readBtwExtensionSources, readBtwWorkspaceMode } from "./btw-extension-tools.ts";

function setup(globalConfig?: unknown, projectConfig?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "btw-ext-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "proj");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  if (globalConfig !== undefined) {
    writeFileSync(join(agentDir, "btw.json"), JSON.stringify(globalConfig));
  }
  if (projectConfig !== undefined) {
    writeFileSync(join(cwd, ".pi", "btw.json"), JSON.stringify(projectConfig));
  }
  return { root, agentDir, cwd };
}

test("no btw.json means no extensions", async () => {
  const { agentDir, cwd } = setup();
  assert.deepEqual(await readBtwExtensionSources({ cwd, agentDir, projectTrusted: true }), []);
});

test("local paths resolve relative to the config, npm:/git: sources stay as-is, duplicates collapse", async () => {
  const { agentDir, cwd } = setup({ extensions: ["./ext.ts", "./ext.ts", "npm:some-pkg"] });
  assert.deepEqual(await readBtwExtensionSources({ cwd, agentDir, projectTrusted: true }), [
    join(agentDir, "ext.ts"),
    "npm:some-pkg",
  ]);
});

test("project list replaces the global one, even when empty", async () => {
  const withProject = setup({ extensions: ["npm:global"] }, { extensions: ["npm:project"] });
  assert.deepEqual(await readBtwExtensionSources({ ...withProject, projectTrusted: true }), [
    "npm:project",
  ]);
  const emptyProject = setup({ extensions: ["npm:global"] }, { extensions: [] });
  assert.deepEqual(await readBtwExtensionSources({ ...emptyProject, projectTrusted: true }), []);
});

test("untrusted projects ignore .pi/btw.json", async () => {
  const dirs = setup({ extensions: ["npm:global"] }, { extensions: ["npm:project"] });
  assert.deepEqual(await readBtwExtensionSources({ ...dirs, projectTrusted: false }), [
    "npm:global",
  ]);
});

test("invalid configs fail loudly", async () => {
  for (const bad of [{ extensions: "npm:x" }, { extensions: [""] }, { other: 1 }]) {
    const dirs = setup(bad);
    await assert.rejects(
      readBtwExtensionSources({ ...dirs, projectTrusted: true }),
      /Invalid BTW config/,
    );
  }
});

test("workspace defaults to local, project overrides global, untrusted projects are ignored", async () => {
  const none = setup();
  assert.equal(await readBtwWorkspaceMode({ ...none, projectTrusted: true }), "local");
  const dirs = setup({ workspace: "ssh" }, { workspace: "local" });
  assert.equal(await readBtwWorkspaceMode({ ...dirs, projectTrusted: true }), "local");
  assert.equal(await readBtwWorkspaceMode({ ...dirs, projectTrusted: false }), "ssh");
  const onlyGlobal = setup({ workspace: "ssh" });
  assert.equal(await readBtwWorkspaceMode({ ...onlyGlobal, projectTrusted: true }), "ssh");
});

test("workspace is validated independently of extensions", async () => {
  const bad = setup({ workspace: "bogus" });
  await assert.rejects(readBtwWorkspaceMode({ ...bad, projectTrusted: true }), /"local" or "ssh"/);
  // A bad workspace value must not stop extensions from loading, and vice versa.
  assert.deepEqual(await readBtwExtensionSources({ ...bad, projectTrusted: true }), []);
  const badExtensions = setup({ extensions: "npm:x", workspace: "ssh" });
  assert.equal(await readBtwWorkspaceMode({ ...badExtensions, projectTrusted: true }), "ssh");
  await assert.rejects(
    readBtwExtensionSources({ ...badExtensions, projectTrusted: true }),
    /Invalid BTW config/,
  );
});
